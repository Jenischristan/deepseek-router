// Command deepseek-transport is a loopback-only HTTP forwarder that sends
// DeepSeek requests through a Firefox-impersonating TLS/HTTP2 client instead of
// Node's HTTP/1.1 + OpenSSL stack.
//
// It is intentionally not a general-purpose proxy: only the DeepSeek hosts the
// router uses are accepted, and every request must carry the shared key that
// the router generates at startup.
package main

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"os/signal"
	"sort"
	"strings"
	"syscall"
	"time"

	fhttp "github.com/bogdanfinn/fhttp"
	tls_client "github.com/bogdanfinn/tls-client"
	"github.com/bogdanfinn/tls-client/profiles"
	tls "github.com/bogdanfinn/utls"
)

const defaultProfile = "firefox_159"

var allowedHosts = map[string]bool{
	"chat.deepseek.com":     true,
	"hif-leim.deepseek.com": true,
	"hif-dliq.deepseek.com": true,
}

// Headers that belong to the local hop or to the sidecar protocol and must not
// be forwarded to DeepSeek.
var skipRequestHeaders = map[string]bool{
	"host":                     true,
	"connection":               true,
	"keep-alive":               true,
	"proxy-connection":         true,
	"proxy-authenticate":       true,
	"proxy-authorization":      true,
	"te":                       true,
	"trailer":                  true,
	"transfer-encoding":        true,
	"upgrade":                  true,
	"expect":                   true,
	"x-deepseek-target":        true,
	"x-deepseek-method":        true,
	"x-deepseek-header-order":  true,
	"x-deepseek-transport-key": true,
}

var skipResponseHeaders = map[string]bool{
	"connection":          true,
	"keep-alive":          true,
	"proxy-authenticate":  true,
	"proxy-authorization": true,
	"te":                  true,
	"trailer":             true,
	"transfer-encoding":   true,
	"upgrade":             true,
}

type sidecar struct {
	client  tls_client.HttpClient
	key     []byte
	profile string
}

func main() {
	listen := flag.String("listen", "127.0.0.1:0", "listen address")
	key := flag.String("key", "", "shared secret required from the router")
	profileName := flag.String("profile", defaultProfile, "tls-client browser profile")
	timeout := flag.Duration("timeout", 15*time.Minute, "upstream request timeout")
	parentPID := flag.Int("parent-pid", 0, "exit when this process disappears")
	flag.Parse()

	if *key == "" {
		log.Fatal("--key is required")
	}

	profile, err := selectProfile(*profileName)
	if err != nil {
		log.Fatal(err)
	}

	client, err := newClient(profile, *timeout, false)
	if err != nil {
		log.Fatalf("create TLS client: %v", err)
	}

	handler := &sidecar{client: client, key: []byte(*key), profile: *profileName}

	mux := http.NewServeMux()
	mux.HandleFunc("/forward", handler.forward)
	mux.HandleFunc("/health", handler.health)

	server := &http.Server{
		Handler:           mux,
		ReadHeaderTimeout: 10 * time.Second,
	}

	listener, err := net.Listen("tcp", *listen)
	if err != nil {
		log.Fatalf("listen: %v", err)
	}

	fmt.Printf("READY http://%s\n", listener.Addr())

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	if *parentPID > 0 {
		go watchParent(ctx, *parentPID, stop)
	}

	go func() {
		<-ctx.Done()
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = server.Shutdown(shutdownCtx)
	}()

	if err := server.Serve(listener); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatalf("serve: %v", err)
	}
}

func newClient(profile profiles.ClientProfile, timeout time.Duration, insecure bool) (tls_client.HttpClient, error) {
	idle := 90 * time.Second
	options := []tls_client.HttpClientOption{
		tls_client.WithClientProfile(profile),
		tls_client.WithTimeoutMilliseconds(int(timeout.Milliseconds())),
		tls_client.WithNotFollowRedirects(),
		tls_client.WithDisableHttp3(),
		tls_client.WithTransportOptions(&tls_client.TransportOptions{
			// Keep the upstream body compressed. The router decodes gzip,
			// deflate, and br through fetch, and zstd through its own wrapper,
			// so the sidecar must not decompress the stream.
			DisableCompression:  true,
			IdleConnTimeout:     &idle,
			MaxIdleConns:        16,
			MaxIdleConnsPerHost: 4,
		}),
	}
	if insecure {
		options = append(options, tls_client.WithInsecureSkipVerify())
	}
	return tls_client.NewHttpClient(tls_client.NewNoopLogger(), options...)
}

// firefox159Profile mirrors the ClientHello of Firefox/Zen 159. The bundled
// Firefox_148 profile is close, but Firefox 149+ dropped the legacy CBC/DHE
// cipher suites and the finite-field DH groups, and uses a 224-byte ECH grease
// payload. The HTTP/2 settings are unchanged from 148, so reuse them.
func firefox159Profile() profiles.ClientProfile {
	base := profiles.Firefox_148
	id := tls.ClientHelloID{
		Client:               "Firefox",
		RandomExtensionOrder: false,
		Version:              "159",
		Seed:                 nil,
		SpecFactory: func() (tls.ClientHelloSpec, error) {
			spec, err := base.GetClientHelloSpec()
			if err != nil {
				return spec, err
			}
			spec.CipherSuites = []uint16{
				tls.TLS_AES_128_GCM_SHA256,
				tls.TLS_CHACHA20_POLY1305_SHA256,
				tls.TLS_AES_256_GCM_SHA384,
				tls.TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256,
				tls.TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256,
				tls.TLS_ECDHE_ECDSA_WITH_CHACHA20_POLY1305_SHA256,
				tls.TLS_ECDHE_RSA_WITH_CHACHA20_POLY1305_SHA256,
				tls.TLS_ECDHE_ECDSA_WITH_AES_256_GCM_SHA384,
				tls.TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384,
				tls.TLS_ECDHE_RSA_WITH_AES_128_CBC_SHA,
				tls.TLS_ECDHE_RSA_WITH_AES_256_CBC_SHA,
				tls.TLS_RSA_WITH_AES_128_GCM_SHA256,
				tls.TLS_RSA_WITH_AES_256_GCM_SHA384,
				tls.TLS_RSA_WITH_AES_128_CBC_SHA,
				tls.TLS_RSA_WITH_AES_256_CBC_SHA,
			}
			for i, ext := range spec.Extensions {
				switch e := ext.(type) {
				case *tls.SupportedCurvesExtension:
					e.Curves = []tls.CurveID{
						tls.X25519MLKEM768,
						tls.X25519,
						tls.CurveP256,
						tls.CurveP384,
						tls.CurveP521,
					}
					spec.Extensions[i] = e
				case *tls.GREASEEncryptedClientHelloExtension:
					e.CandidatePayloadLens = []uint16{224}
					spec.Extensions[i] = e
				}
			}
			return spec, nil
		},
	}

	return profiles.NewClientProfile(
		id,
		base.GetSettings(),
		base.GetSettingsOrder(),
		base.GetPseudoHeaderOrder(),
		base.GetConnectionFlow(),
		base.GetPriorities(),
		base.GetHeaderPriority(),
		base.GetStreamID(),
		base.GetAllowHTTP(),
		base.GetHttp3Settings(),
		base.GetHttp3SettingsOrder(),
		base.GetHttp3PriorityParam(),
		base.GetHttp3PseudoHeaderOrder(),
		base.GetHttp3SendGreaseFrames(),
	)
}

func selectProfile(name string) (profiles.ClientProfile, error) {
	key := strings.ToLower(strings.TrimSpace(name))
	if key == "" || key == "firefox" {
		key = defaultProfile
	}
	if key == "firefox_159" {
		return firefox159Profile(), nil
	}
	profile, ok := profiles.MappedTLSClients[key]
	if !ok {
		return profiles.ClientProfile{}, fmt.Errorf("unknown profile %q", name)
	}
	return profile, nil
}

func (s *sidecar) authorized(r *http.Request) bool {
	got := r.Header.Get("x-deepseek-transport-key")
	return subtle.ConstantTimeCompare([]byte(got), s.key) == 1
}

func (s *sidecar) health(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("content-type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{
		"ok":      true,
		"profile": s.profile,
	})
}

func (s *sidecar) forward(w http.ResponseWriter, r *http.Request) {
	started := time.Now()

	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if !s.authorized(r) {
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}

	target, err := url.Parse(r.Header.Get("x-deepseek-target"))
	if err != nil || !allowedTarget(target) {
		http.Error(w, "invalid target", http.StatusBadRequest)
		return
	}

	method := strings.ToUpper(strings.TrimSpace(r.Header.Get("x-deepseek-method")))
	if method == "" {
		method = http.MethodGet
	}

	req, err := fhttp.NewRequestWithContext(r.Context(), method, target.String(), r.Body)
	if err != nil {
		http.Error(w, "invalid request", http.StatusBadRequest)
		return
	}
	req.ContentLength = r.ContentLength

	for name, values := range r.Header {
		lower := strings.ToLower(name)
		if skipRequestHeaders[lower] {
			continue
		}
		req.Header[lower] = append(req.Header[lower], values...)
	}

	if order := headerOrder(r.Header.Get("x-deepseek-header-order"), req.Header); len(order) > 0 {
		req.Header[fhttp.HeaderOrderKey] = order
	}

	resp, err := s.client.Do(req)
	if err != nil {
		log.Printf("%s %s%s failed after %s: %v", method, target.Host, target.Path, time.Since(started).Round(time.Millisecond), err)
		http.Error(w, "upstream request failed", http.StatusBadGateway)
		return
	}
	defer resp.Body.Close()

	for name, values := range resp.Header {
		lower := strings.ToLower(name)
		if skipResponseHeaders[lower] {
			continue
		}
		for _, value := range values {
			w.Header().Add(name, value)
		}
	}
	w.Header().Set("x-deepseek-transport-profile", s.profile)
	w.Header().Set("x-deepseek-upstream-proto", resp.Proto)
	w.WriteHeader(resp.StatusCode)

	flusher, _ := w.(http.Flusher)
	buf := make([]byte, 32*1024)
	for {
		n, readErr := resp.Body.Read(buf)
		if n > 0 {
			if _, writeErr := w.Write(buf[:n]); writeErr != nil {
				return
			}
			if flusher != nil {
				flusher.Flush()
			}
		}
		if readErr != nil {
			if !errors.Is(readErr, io.EOF) {
				log.Printf("%s %s%s body failed after %s: %v", method, target.Host, target.Path, time.Since(started).Round(time.Millisecond), readErr)
			}
			break
		}
	}

	log.Printf("%s %s%s %d %s %s", method, target.Host, target.Path, resp.StatusCode, resp.Proto, time.Since(started).Round(time.Millisecond))
}

func allowedTarget(target *url.URL) bool {
	if target == nil || target.Scheme != "https" || target.User != nil {
		return false
	}
	if port := target.Port(); port != "" && port != "443" {
		return false
	}
	return allowedHosts[strings.ToLower(target.Hostname())]
}

// headerOrder keeps the order the router built, then appends anything that was
// not listed so no header is silently dropped.
func headerOrder(raw string, headers fhttp.Header) []string {
	seen := make(map[string]bool, len(headers))
	order := make([]string, 0, len(headers))

	for _, name := range strings.Split(raw, ",") {
		name = strings.ToLower(strings.TrimSpace(name))
		if name == "" || seen[name] {
			continue
		}
		if _, ok := headers[name]; !ok {
			continue
		}
		seen[name] = true
		order = append(order, name)
	}

	rest := make([]string, 0, len(headers))
	for name := range headers {
		if name == fhttp.HeaderOrderKey || name == fhttp.PHeaderOrderKey {
			continue
		}
		if !seen[name] {
			rest = append(rest, name)
		}
	}
	sort.Strings(rest)
	return append(order, rest...)
}

func watchParent(ctx context.Context, pid int, stop context.CancelFunc) {
	ticker := time.NewTicker(2 * time.Second)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if err := syscall.Kill(pid, 0); err != nil && !errors.Is(err, syscall.EPERM) {
				log.Printf("parent %d exited, shutting down", pid)
				stop()
				return
			}
		}
	}
}

package main

import (
	"bytes"
	"compress/gzip"
	"context"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

	fhttp "github.com/bogdanfinn/fhttp"
	tls_client "github.com/bogdanfinn/tls-client"
	"github.com/bogdanfinn/tls-client/profiles"
)

func TestAllowedTarget(t *testing.T) {
	cases := []struct {
		target string
		want   bool
	}{
		{"https://chat.deepseek.com/api/v0/chat/completion", true},
		{"https://chat.deepseek.com:443/api/v0/chat/completion", true},
		{"https://hif-leim.deepseek.com/query", true},
		{"https://hif-dliq.deepseek.com/query", true},
		{"http://chat.deepseek.com/api", false},
		{"https://chat.deepseek.com:8443/api", false},
		{"https://evil.example/api", false},
		{"https://chat.deepseek.com.evil.example/api", false},
		{"https://user:pass@chat.deepseek.com/api", false},
	}
	for _, tc := range cases {
		u, err := url.Parse(tc.target)
		if err != nil {
			t.Fatalf("parse %q: %v", tc.target, err)
		}
		if got := allowedTarget(u); got != tc.want {
			t.Errorf("allowedTarget(%q) = %v, want %v", tc.target, got, tc.want)
		}
	}
}

func TestHeaderOrder(t *testing.T) {
	headers := fhttp.Header{
		"user-agent":     {"test"},
		"accept":         {"*/*"},
		"cookie":         {"a=b"},
		"content-length": {"7"},
		"origin":         {"https://chat.deepseek.com"},
	}
	got := headerOrder("user-agent,content-length,origin,accept,missing", headers)
	want := []string{"user-agent", "content-length", "origin", "accept", "cookie"}
	if len(got) != len(want) {
		t.Fatalf("headerOrder = %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("headerOrder = %v, want %v", got, want)
		}
	}
}

func TestForwardHTTP2Streaming(t *testing.T) {
	var gotMethod, gotAuthorization, gotCookie, gotHif, gotBody string
	var gotControlHeader, gotContentLength string

	upstream := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotMethod = r.Method
		gotAuthorization = r.Header.Get("authorization")
		gotCookie = r.Header.Get("cookie")
		gotHif = r.Header.Get("x-hif-leim")
		gotControlHeader = r.Header.Get("x-deepseek-target")
		gotContentLength = r.Header.Get("content-length")
		body, _ := io.ReadAll(r.Body)
		gotBody = string(body)

		w.Header().Set("content-type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		flusher := w.(http.Flusher)
		for _, chunk := range []string{"data: one\n\n", "data: two\n\n", "data: three\n\n"} {
			_, _ = io.WriteString(w, chunk)
			flusher.Flush()
		}
	}))
	upstream.EnableHTTP2 = true
	upstream.StartTLS()
	defer upstream.Close()

	client := newTestClient(t, upstream.Listener.Addr().String())
	s := &sidecar{client: client, key: []byte("secret"), profile: "firefox_148"}

	req := httptest.NewRequest(http.MethodPost, "/forward", strings.NewReader(`{"prompt":"hi"}`))
	req.Header.Set("x-deepseek-transport-key", "secret")
	req.Header.Set("x-deepseek-target", "https://chat.deepseek.com/api/v0/chat/completion")
	req.Header.Set("x-deepseek-method", http.MethodPost)
	req.Header.Set("x-deepseek-header-order", "user-agent,accept,content-type")
	req.Header.Set("user-agent", "test-agent")
	req.Header.Set("accept", "*/*")
	req.Header.Set("content-type", "application/json")
	req.Header.Set("accept-encoding", "gzip, deflate, br")
	req.Header.Set("authorization", "Bearer token")
	req.Header.Set("cookie", "smidV2=a")
	req.Header.Set("x-hif-leim", "leim-value")

	rec := httptest.NewRecorder()
	s.forward(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", rec.Code, rec.Body.String())
	}
	if gotMethod != http.MethodPost {
		t.Errorf("upstream method = %q, want POST", gotMethod)
	}
	if gotAuthorization != "Bearer token" {
		t.Errorf("authorization = %q", gotAuthorization)
	}
	if gotCookie != "smidV2=a" {
		t.Errorf("cookie = %q", gotCookie)
	}
	if gotHif != "leim-value" {
		t.Errorf("x-hif-leim = %q", gotHif)
	}
	if gotControlHeader != "" {
		t.Errorf("control header leaked upstream: %q", gotControlHeader)
	}
	if gotBody != `{"prompt":"hi"}` {
		t.Errorf("body = %q", gotBody)
	}
	if gotContentLength != "15" {
		t.Errorf("content-length = %q, want 15", gotContentLength)
	}
	if proto := rec.Header().Get("x-deepseek-upstream-proto"); proto != "HTTP/2.0" {
		t.Errorf("upstream proto = %q, want HTTP/2.0", proto)
	}
	for _, want := range []string{"data: one", "data: two", "data: three"} {
		if !strings.Contains(rec.Body.String(), want) {
			t.Errorf("response body missing %q: %s", want, rec.Body.String())
		}
	}
}

func TestForwardKeepsCompressionForNode(t *testing.T) {
	var compressed bytes.Buffer
	zw := gzip.NewWriter(&compressed)
	_, _ = io.WriteString(zw, "data: compressed\n\n")
	if err := zw.Close(); err != nil {
		t.Fatalf("gzip: %v", err)
	}

	upstream := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("content-type", "text/event-stream")
		w.Header().Set("content-encoding", "gzip")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(compressed.Bytes())
	}))
	upstream.EnableHTTP2 = true
	upstream.StartTLS()
	defer upstream.Close()

	client := newTestClient(t, upstream.Listener.Addr().String())
	s := &sidecar{client: client, key: []byte("secret"), profile: "firefox_148"}

	req := httptest.NewRequest(http.MethodPost, "/forward", nil)
	req.Header.Set("x-deepseek-transport-key", "secret")
	req.Header.Set("x-deepseek-target", "https://hif-leim.deepseek.com/query")
	req.Header.Set("x-deepseek-method", http.MethodGet)
	req.Header.Set("accept-encoding", "gzip, deflate, br")

	rec := httptest.NewRecorder()
	s.forward(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", rec.Code, rec.Body.String())
	}
	if got := rec.Header().Get("content-encoding"); got != "gzip" {
		t.Fatalf("content-encoding = %q, want gzip", got)
	}
	if !bytes.Equal(rec.Body.Bytes(), compressed.Bytes()) {
		t.Fatalf("compressed body changed: got %d bytes, want %d", rec.Body.Len(), compressed.Len())
	}

	zr, err := gzip.NewReader(rec.Body)
	if err != nil {
		t.Fatalf("gzip reader: %v", err)
	}
	plain, err := io.ReadAll(zr)
	if err != nil {
		t.Fatalf("decompress: %v", err)
	}
	if string(plain) != "data: compressed\n\n" {
		t.Fatalf("decompressed body = %q", plain)
	}
}

func TestForwardRejectsBadKeyAndTarget(t *testing.T) {
	s := &sidecar{key: []byte("secret"), profile: "firefox_148"}

	req := httptest.NewRequest(http.MethodPost, "/forward", nil)
	req.Header.Set("x-deepseek-target", "https://chat.deepseek.com/api")
	rec := httptest.NewRecorder()
	s.forward(rec, req)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("bad key status = %d, want 403", rec.Code)
	}

	req = httptest.NewRequest(http.MethodPost, "/forward", nil)
	req.Header.Set("x-deepseek-transport-key", "secret")
	req.Header.Set("x-deepseek-target", "https://evil.example/api")
	rec = httptest.NewRecorder()
	s.forward(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("bad target status = %d, want 400", rec.Code)
	}
}

func newTestClient(t *testing.T, upstreamAddr string) tls_client.HttpClient {
	t.Helper()
	client, err := tls_client.NewHttpClient(
		tls_client.NewNoopLogger(),
		tls_client.WithClientProfile(profiles.Firefox_148),
		tls_client.WithInsecureSkipVerify(),
		tls_client.WithNotFollowRedirects(),
		tls_client.WithDisableHttp3(),
		tls_client.WithTimeoutSeconds(10),
		tls_client.WithTransportOptions(&tls_client.TransportOptions{
			DisableCompression: true,
		}),
		tls_client.WithDialContext(func(ctx context.Context, network, _ string) (net.Conn, error) {
			return (&net.Dialer{}).DialContext(ctx, network, upstreamAddr)
		}),
	)
	if err != nil {
		t.Fatalf("create test client: %v", err)
	}
	return client
}

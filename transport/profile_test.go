package main

import (
	"slices"
	"testing"

	tls "github.com/bogdanfinn/utls"
)

func TestFirefox159ProfileMatchesZen159(t *testing.T) {
	profile, err := selectProfile("firefox_159")
	if err != nil {
		t.Fatal(err)
	}
	spec, err := profile.GetClientHelloSpec()
	if err != nil {
		t.Fatal(err)
	}

	wantCiphers := []uint16{
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
	if !slices.Equal(spec.CipherSuites, wantCiphers) {
		t.Fatalf("cipher suites = %v, want %v", spec.CipherSuites, wantCiphers)
	}

	wantCurves := []tls.CurveID{
		tls.X25519MLKEM768,
		tls.X25519,
		tls.CurveP256,
		tls.CurveP384,
		tls.CurveP521,
	}
	var curves []tls.CurveID
	var ech *tls.GREASEEncryptedClientHelloExtension
	for _, ext := range spec.Extensions {
		switch e := ext.(type) {
		case *tls.SupportedCurvesExtension:
			curves = e.Curves
		case *tls.GREASEEncryptedClientHelloExtension:
			ech = e
		}
	}
	if !slices.Equal(curves, wantCurves) {
		t.Fatalf("curves = %v, want %v", curves, wantCurves)
	}
	if ech == nil {
		t.Fatal("missing ECH grease extension")
	}
	if !slices.Equal(ech.CandidatePayloadLens, []uint16{224}) {
		t.Fatalf("ECH payload lengths = %v, want [224]", ech.CandidatePayloadLens)
	}
}

func TestFirefox148ProfileStillSelectable(t *testing.T) {
	if _, err := selectProfile("firefox_148"); err != nil {
		t.Fatal(err)
	}
}

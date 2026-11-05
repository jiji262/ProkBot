package core

import (
	"context"
	"net"
	"testing"
	"time"
)

func TestStopListeningReleasesPortBeforeNetworkCleanup(t *testing.T) {
	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	address := listener.Addr().String()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	tunnel := &Tunnel{listener: listener, ctx: ctx, cancel: cancel, connections: map[net.Conn]bool{}, state: State{Listening: true}}
	done := make(chan struct{})
	go func() {
		tunnel.accept(listener, func(context.Context) (net.Conn, error) {
			t.Error("health inspection must not open a peer connection")
			return nil, context.Canceled
		})
		close(done)
	}()
	if !tunnel.Status().Listening {
		t.Fatal("listener should be ready")
	}
	tunnel.StopListening()
	if tunnel.Status().Listening {
		t.Fatal("closed listener reported ready")
	}
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("accept did not stop")
	}
	replacement, err := net.Listen("tcp4", address)
	if err != nil {
		t.Fatalf("port was not released: %v", err)
	}
	replacement.Close()
	tunnel.Close()
}

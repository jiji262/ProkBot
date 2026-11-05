// Package core provides the same TCP transport to Docker, Electron and iOS.
// Application authentication remains in Host and the execution gateway.
package core

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/url"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/tailscale/tailcat"
	"tailscale.com/tailcfg"
)

type Config struct {
	Mode       string              `json:"mode"`
	Identity   *tailcat.PrivateKey `json:"identity,omitempty"`
	Link       string              `json:"link,omitempty"`
	Target     string              `json:"target,omitempty"`
	LocalPort  uint16              `json:"localPort,omitempty"`
	Port       uint16              `json:"port,omitempty"`
	DERPMapURL string              `json:"derpMapURL,omitempty"`
	Relay      string              `json:"relay,omitempty"`
}

type State struct {
	Listening bool   `json:"listening"`
	Accepted  uint64 `json:"accepted"`
	Forwarded uint64 `json:"forwarded"`
	State     string `json:"state"`
	Path      string `json:"path"`
	LocalURL  string `json:"localURL,omitempty"`
	Link      string `json:"link,omitempty"`
	PublicKey string `json:"publicKey"`
	Error     string `json:"error,omitempty"`
}

type Tunnel struct {
	mu          sync.Mutex
	state       State
	Identity    *tailcat.PrivateKey
	ctx         context.Context
	cancel      context.CancelFunc
	listener    net.Listener
	client      *tailcat.Client
	server      *tailcat.Server
	connections map[net.Conn]bool
	closed      bool
}

// ParseLink never performs network I/O or DNS resolution.
func ParseLink(input string) (tailcat.Addr, uint16, error) {
	input = strings.TrimSpace(input)
	address, port := input, uint16(8000)
	if strings.HasPrefix(input, "tailcat://") {
		u, err := url.Parse(input)
		if err != nil || u.Host != "connect" || u.User != nil || u.Fragment != "" {
			return "", 0, errors.New("invalid Tailcat link")
		}
		address = strings.TrimPrefix(u.Path, "/")
		p, err := strconv.ParseUint(u.Query().Get("port"), 10, 16)
		if err != nil || p == 0 || len(u.Query()) != 1 {
			return "", 0, errors.New("invalid Tailcat port")
		}
		port = uint16(p)
	}
	if len(address) > 16384 || !strings.HasPrefix(address, "tc") {
		return "", 0, errors.New("invalid Tailcat address")
	}
	if _, err := tailcat.ParseAddr(tailcat.Addr(address)); err != nil {
		return "", 0, errors.New("invalid Tailcat address")
	}
	return tailcat.Addr(address), port, nil
}

func Start(config Config) (*Tunnel, error) {
	if config.Identity == nil {
		config.Identity = tailcat.NewPrivateKey()
	}
	if config.Identity.Private.IsZero() {
		return nil, errors.New("invalid tunnel identity")
	}
	ctx, cancel := context.WithCancel(context.Background())
	t := &Tunnel{Identity: config.Identity, ctx: ctx, cancel: cancel, connections: map[net.Conn]bool{},
		state: State{State: "connecting", Path: "unknown", PublicKey: config.Identity.Private.Public().String()}}
	var err error
	switch config.Mode {
	case "forward":
		err = t.forward(config)
	case "serve":
		err = t.serve(config)
	default:
		err = errors.New("invalid tunnel mode")
	}
	if err != nil {
		t.Close()
		return nil, err
	}
	return t, nil
}

func (t *Tunnel) forward(config Config) error {
	address, port, err := ParseLink(config.Link)
	if err != nil {
		return err
	}
	t.client = &tailcat.Client{Server: address, Key: t.Identity.Private, Logf: discard, DERPMapURL: config.DERPMapURL}
	// Binding is synchronous; connecting is asynchronous, including on cold launch.
	t.listener, err = net.Listen("tcp4", fmt.Sprintf("127.0.0.1:%d", config.LocalPort))
	if err != nil {
		return errors.New("cannot open local tunnel port")
	}
	t.state.LocalURL = "http://" + t.listener.Addr().String()
	t.state.Listening = true
	go t.accept(t.listener, func(ctx context.Context) (net.Conn, error) { return t.client.DialTCPPort(ctx, port) })
	go t.monitor()
	return nil
}

func (t *Tunnel) serve(config Config) error {
	if config.Port == 0 {
		config.Port = 8000
	}
	host, p, err := net.SplitHostPort(config.Target)
	if err != nil || host == "" {
		return errors.New("invalid tunnel target")
	}
	if number, err := strconv.Atoi(p); err != nil || number < 1 || number > 65535 {
		return errors.New("invalid tunnel target")
	}
	t.server = &tailcat.Server{Key: t.Identity.Private, PresharedKey: t.Identity.Public.PresharedKey, Logf: discard,
		DERPMapURL: config.DERPMapURL}
	if config.Relay != "" {
		u, err := url.Parse("https://" + config.Relay)
		if err != nil || u.Hostname() == "" || u.User != nil || u.Path != "" || u.RawQuery != "" || u.Fragment != "" {
			return errors.New("invalid DERP relay")
		}
		port := 443
		if u.Port() != "" {
			port, err = strconv.Atoi(u.Port())
			if err != nil || port < 1 || port > 65535 {
				return errors.New("invalid DERP port")
			}
		}
		t.server.Region = &tailcfg.DERPRegion{RegionID: 999, RegionCode: "custom", RegionName: "Custom relay",
			Nodes: []*tailcfg.DERPNode{{Name: "custom", RegionID: 999, HostName: u.Hostname(), DERPPort: port}}}
	} else if len(t.Identity.Public.Region) > 0 && config.DERPMapURL == "" {
		t.server.Region = t.Identity.Public.Region[0]
	} else if config.DERPMapURL == "" {
		t.server.RegionID = t.Identity.Public.RegionID
	}
	ctx, cancel := context.WithTimeout(t.ctx, 35*time.Second)
	defer cancel()
	t.listener, err = t.server.Listen(ctx, "tcp", fmt.Sprintf(":%d", config.Port))
	if err != nil {
		return errors.New("Tailcat relay unavailable")
	}
	address, err := t.server.TailcatAddr().Resolve(ctx)
	if err != nil {
		return errors.New("cannot resolve Tailcat relay")
	}
	info, err := tailcat.ParseAddr(address)
	if err != nil {
		return errors.New("invalid server identity")
	}
	t.Identity.Public = info
	t.state.Link = fmt.Sprintf("tailcat://connect/%s?port=%d", address, config.Port)
	t.state.State = "ready"
	t.state.Listening = true
	go t.accept(t.listener, func(ctx context.Context) (net.Conn, error) {
		return (&net.Dialer{Timeout: 15 * time.Second}).DialContext(ctx, "tcp", config.Target)
	})
	return nil
}

// Diagnostic output is local only and disabled by default.
func discard(format string, args ...any) {
	if os.Getenv("GROKBOT_TAILCAT_DEBUG") == "1" {
		log.Printf(format, args...)
	}
}

func (t *Tunnel) track(c net.Conn) bool {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.closed {
		c.Close()
		return false
	}
	t.connections[c] = true
	return true
}
func (t *Tunnel) untrack(c net.Conn) { c.Close(); t.mu.Lock(); delete(t.connections, c); t.mu.Unlock() }

func (t *Tunnel) accept(listener net.Listener, dial func(context.Context) (net.Conn, error)) {
	defer func() { t.mu.Lock(); t.state.Listening = false; t.mu.Unlock() }()
	for {
		c, err := listener.Accept()
		if err != nil {
			return
		}
		if !t.track(c) {
			return
		}
		t.mu.Lock()
		t.state.Accepted++
		t.mu.Unlock()
		go func() {
			defer t.untrack(c)
			ctx, cancel := context.WithTimeout(t.ctx, 30*time.Second)
			u, err := dial(ctx)
			cancel()
			if err != nil {
				t.mu.Lock()
				t.state.Error = "Destination connection failed"
				t.mu.Unlock()
				return
			}
			t.mu.Lock()
			t.state.Forwarded++
			t.state.Error = ""
			t.mu.Unlock()
			if !t.track(u) {
				return
			}
			defer t.untrack(u)
			done := make(chan struct{})
			go func() {
				io.Copy(u, c)
				if h, ok := u.(interface{ CloseWrite() error }); ok {
					h.CloseWrite()
				}
				close(done)
			}()
			io.Copy(c, u)
			c.Close()
			u.Close()
			<-done
		}()
	}
}

func (t *Tunnel) monitor() {
	for {
		ctx, cancel := context.WithTimeout(t.ctx, 12*time.Second)
		_, err := t.client.Ping(ctx)
		state, path := "connecting", "unknown"
		if err == nil {
			ping, e := t.client.DiscoPing(ctx)
			if e == nil && ping != nil {
				// Ping's initial handshake is cached by the client. A live
				// disco reply is required after a suspension or network change.
				state = "ready"
				if ping.Endpoint != "" {
					path = "direct"
				} else if ping.DERPRegionID != 0 {
					path = "relay"
				}
			}
		}
		cancel()
		t.mu.Lock()
		if !t.closed {
			t.state.State = state
			t.state.Path = path
		}
		t.mu.Unlock()
		select {
		case <-t.ctx.Done():
			return
		case <-time.After(10 * time.Second):
		}
	}
}

func (t *Tunnel) Status() State { t.mu.Lock(); defer t.mu.Unlock(); return t.state }

// Release the loopback port without waiting for the peer/network stack to close.
func (t *Tunnel) StopListening() {
	t.mu.Lock()
	listener := t.listener
	t.listener = nil
	t.state.Listening = false
	t.mu.Unlock()
	if listener != nil {
		listener.Close()
	}
}
func (t *Tunnel) Close() {
	t.mu.Lock()
	if t.closed {
		t.mu.Unlock()
		return
	}
	t.closed = true
	t.state.State = "closed"
	t.cancel()
	for c := range t.connections {
		c.Close()
	}
	t.mu.Unlock()
	t.StopListening()
	if t.client != nil {
		t.client.Close()
	}
	if t.server != nil {
		t.server.Close()
	}
}

// JSON methods are the small ABI used by the native iOS wrapper.
func NewIdentity() string { b, _ := json.Marshal(tailcat.NewPrivateKey()); return string(b) }
func IdentityPublic(raw string) string {
	var identity tailcat.PrivateKey
	if json.Unmarshal([]byte(raw), &identity) != nil || identity.Private.IsZero() {
		return ""
	}
	return identity.Private.Public().String()
}

package main

import (
	"encoding/json"
	"os"
	"os/signal"
	"syscall"
	"time"

	"grokbot.local/tunnel/core"
)

// Secrets arrive through stdin, never command-line arguments or logs.
func main() {
	var config core.Config
	decoder := json.NewDecoder(os.Stdin)
	if decoder.Decode(&config) != nil {
		os.Exit(2)
	}
	t, err := core.Start(config)
	if err != nil {
		json.NewEncoder(os.Stdout).Encode(map[string]any{"error": err.Error()})
		os.Exit(1)
	}
	defer t.Close()
	output := json.NewEncoder(os.Stdout)
	output.Encode(map[string]any{"ready": true, "identity": t.Identity, "status": t.Status()})
	parentClosed := make(chan struct{})
	go func() { var value any; decoder.Decode(&value); close(parentClosed) }()
	stop := make(chan os.Signal, 1)
	signal.Notify(stop, os.Interrupt, syscall.SIGTERM)
	ticker := time.NewTicker(5 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-parentClosed:
			return
		case <-stop:
			return
		case <-ticker.C:
			output.Encode(map[string]any{"status": t.Status()})
		}
	}
}

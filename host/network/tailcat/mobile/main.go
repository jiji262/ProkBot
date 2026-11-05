package main

/*
#include <stdlib.h>
*/
import "C"
import (
	"encoding/json"
	"grokbot.local/tunnel/core"
	"sync"
	"unsafe"
)

var mu sync.Mutex
var sessions = map[int]*core.Tunnel{}
var nextID int

//export GBTailcatIdentity
func GBTailcatIdentity() *C.char { return C.CString(core.NewIdentity()) }

//export GBTailcatStart
func GBTailcatStart(raw *C.char) *C.char {
	var config core.Config
	if json.Unmarshal([]byte(C.GoString(raw)), &config) != nil || config.Mode != "forward" {
		return C.CString(`{"error":"invalid configuration"}`)
	}
	t, err := core.Start(config)
	if err != nil {
		return C.CString(`{"error":"cannot start Tailcat"}`)
	}
	mu.Lock()
	nextID++
	id := nextID
	sessions[id] = t
	mu.Unlock()
	value, _ := json.Marshal(map[string]any{"handle": id, "status": t.Status()})
	return C.CString(string(value))
}

//export GBTailcatStatus
func GBTailcatStatus(id C.int) *C.char {
	mu.Lock()
	t := sessions[int(id)]
	mu.Unlock()
	if t == nil {
		return C.CString(`{"state":"disabled"}`)
	}
	value, _ := json.Marshal(t.Status())
	return C.CString(string(value))
}

//export GBTailcatStop
func GBTailcatStop(id C.int) {
	mu.Lock()
	t := sessions[int(id)]
	delete(sessions, int(id))
	mu.Unlock()
	if t != nil {
		t.StopListening()
		go t.Close()
	}
}

//export GBTailcatFree
func GBTailcatFree(p *C.char) { C.free(unsafe.Pointer(p)) }
func main()                   {}

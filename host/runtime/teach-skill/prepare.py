#!/usr/bin/env python3
"""Claim only an authenticated Host-submitted queue scope; extract bounded frames."""
import hashlib
import json
import os
import pathlib
import re
import subprocess
import sys
import time

scope = sys.argv[1] if len(sys.argv) == 2 else ""
if not re.fullmatch(r"[0-9a-f]{64}", scope):
    raise SystemExit("Expected the Host's teach queue scope")
root = pathlib.Path("/workspace/teach-sessions")
queue = root / "queues" / scope
if queue.is_symlink() or queue.resolve() != queue or root.is_symlink():
    raise SystemExit("Invalid queue location")
pending, claimed = queue / "pending", queue / "claimed"
if pending.is_symlink() or claimed.is_symlink():
    raise SystemExit("Invalid queue directory")
claimed.mkdir(parents=True, exist_ok=True)
entries = sorted(pending.glob("*.json")) + sorted(claimed.glob("*.json"))
if not entries:
    raise SystemExit("No completed demonstration in this queue")
entry = entries[0]
if entry.is_symlink() or not re.fullmatch(r"teach-\d{8}T\d{6}Z-[0-9a-f-]{36}\.json", entry.name):
    raise SystemExit("Invalid recording entry")
data = json.loads(entry.read_text())
if hashlib.sha256(str(data.get("agentId", "")).encode()).hexdigest() != scope:
    raise SystemExit("Recording belongs to another Bot")
folder = root / entry.stem
if data.get("sessionDir") != str(folder) or folder.is_symlink() or not folder.is_dir():
    raise SystemExit("Recording location mismatch")
video = folder / "demo.mp4"
if video.is_symlink() or not video.is_file():
    raise SystemExit("Recording is unavailable")
# The original stop sends SIGINT; wait briefly for ffmpeg to finalize the MP4.
for attempt in range(10):
    probe = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "json", str(video)], capture_output=True, text=True, timeout=10)
    if probe.returncode == 0:
        break
    time.sleep(.2)
if probe.returncode:
    raise SystemExit("Recording has not finished writing")
duration = float(json.loads(probe.stdout)["format"]["duration"])
if not 0 < duration <= 620:
    raise SystemExit("Unexpected recording duration")
destination = claimed / entry.name
if entry.parent == pending:
    os.rename(entry, destination)
frames = folder / "frames"
frames.mkdir(exist_ok=True)
count = min(24, max(2, int(duration / 2) + 1))
subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", str(video), "-vf", f"fps={count / duration},scale=1280:-2", "-frames:v", str(count), str(frames / "frame-%03d.png")], check=True, timeout=90)
print(json.dumps({"queue": str(destination), "recording": str(video), "durationSeconds": duration,
                  "sampleIntervalSeconds": duration / count, "frames": [str(p) for p in sorted(frames.glob("frame-*.png"))]}, ensure_ascii=False))

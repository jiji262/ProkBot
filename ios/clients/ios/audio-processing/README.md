# Client audio processing

Fixed WebRTC Audio Processing 1.3, Abseil 20230125.1, and a C adapter for iOS arm64. The original Grok Bot application is not part of this module.

`GBAudioProcessingCreate(rate)` accepts 8,000, 16,000, 24,000, 32,000, 44,100 or 48,000 Hz mono float PCM, including Bluetooth headset rates. Feed exactly `rate / 100` samples per call. Buffer non-aligned tap frames in the client. WebRTC performs its own internal sample-rate conversion.

Call `Render` with the actual loudspeaker signal, set the measured output/input timestamp delay, and call `Capture` with microphone audio. Keep all calls for one instance on the same serial queue. Output may share the capture input buffer. The API allocates during creation/configuration; the adapter itself allocates no buffers while processing frames.

When playback and capture hardware use different rates, call `GBAudioProcessingRenderAtRate(processor, reference, renderRate)` with exactly `renderRate / 100` frames. WebRTC maintains the reverse-stream resampler internally; do not relabel each variable-length `AVAudioConverter` output with the input callback timestamp.

`GBAudioProcessingCreateResidual(rate)` is an explicit profile for input already processed by a system voice unit. It changes only the dominant near-end trigger from 12 to 2 analysis blocks, preserving the beginning of short interruptions. The normal constructor retains upstream defaults.

AEC3 is enabled; gain control and noise suppression are disabled by default. `GBAudioProcessingSetNoiseSuppression(processor, 1)` enables moderate suppression. The client chooses whether to supplement or replace system processing and owns the audio-session configuration.

## Build

Maintainers need Xcode with the iOS SDK, Python 3, Meson and Ninja:

```sh
python3 clients/ios/audio-processing/build.py \
  --output clients/ios/audio-processing/prebuilt/ios-arm64
```

The script validates three pinned archive hashes, builds arm64 iOS 15.1+ code, and combines the adapter and dependencies into `libGBAudioProcessing.a`. `--platform macos` builds the same adapter for local offline validation. Link the library with C++ runtime and CoreFoundation. The default `clients/ios/build.py` links this pinned library and negotiates `native-aec3-buffered-v1`. `--legacy-voice` builds turn-taking voice without the extra processing. The original experimental voice setting still controls the call entry point.

The iOS integration copies system-owned microphone tap storage into a reusable buffer before processing. It keeps capture continuous, while the Host confirms sustained speech before interrupting playback. See [buffered confirmation and device results](../../../docs/realtime-voice.md): four final iPhone 11 fixture calls had no unexpected input turns, but word recognition and human/headset testing remain incomplete.

`check.cc` exercises both constructors, all supported sample rates, 44.1 kHz render with 48 kHz capture, optional suppression, finite output and invalid-rate rejection. Compile it against a macOS build of the adapter to run locally. Acoustic validation uses actual microphone and playback-reference recordings separately.

The Objective-C integration test runs the actual iOS `GBVoiceEcho` class on macOS, using generated audio and no microphone permission. It checks mixed-rate playback, 10 ms FIFO continuity across irregular tap buffers, stereo channels, and invalid formats:

```sh
python3 clients/ios/audio-processing/build.py --platform macos \
  --output .runtime/audio-processing-macos
xcrun clang -O2 -fobjc-arc -fblocks -Iclients/ios \
  tests/ios-voice-echo.m clients/ios/GBVoiceEcho.m \
  .runtime/audio-processing-macos/libGBAudioProcessing.a \
  -framework Foundation -framework AVFoundation -framework CoreFoundation \
  -lc++ -o .runtime/ios-voice-echo-test
.runtime/ios-voice-echo-test
```

Input archives come from the [GStreamer source mirror](https://gstreamer.freedesktop.org/src/mirror/webrtc-audio-processing/). Versions and SHA-256 values are recorded in `build.py` and the output `build.json`. The `licenses/` directory contains WebRTC, patent grant, embedded DSP components, Abseil and build-overlay notices.

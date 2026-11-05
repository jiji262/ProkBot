#include "GBAudioProcessing.h"
#include <array>
#include <cmath>
#include <cstdio>

int main() {
  if (GBAudioProcessingCreate(12345) != nullptr) return 1;
  if (GBAudioProcessingCreateResidual(12345) != nullptr) return 1;
  for (bool residual : {false, true}) {
  for (int rate : {8000, 16000, 24000, 32000, 44100, 48000}) {
    auto *processor = residual ? GBAudioProcessingCreateResidual(rate)
                               : GBAudioProcessingCreate(rate);
    if (!processor) return 2;
    std::array<float, 480> microphone{}, reference{}, output{};
    const int count = rate / 100;
    for (int enabled : {0, 1}) {
      GBAudioProcessingSetNoiseSuppression(processor, enabled);
      GBAudioProcessingSetDelay(processor, 50);
      for (int frame = 0; frame < 100; ++frame) {
        for (int i = 0; i < count; ++i) {
          double time = static_cast<double>(frame * count + i) / rate;
          reference[i] = static_cast<float>(0.05 * std::sin(time * 600));
          microphone[i] = static_cast<float>(0.01 * std::sin(time * 1000));
        }
        if (GBAudioProcessingRender(processor, reference.data()) != 0 ||
            GBAudioProcessingCapture(processor, microphone.data(), output.data()) != 0) return 3;
        for (int i = 0; i < count; ++i) if (!std::isfinite(output[i])) return 4;
      }
    }
    GBAudioProcessingDestroy(processor);
    std::printf("%s %d Hz passed\n", residual ? "residual" : "default", rate);
  }
  auto *mixed = residual ? GBAudioProcessingCreateResidual(48000)
                         : GBAudioProcessingCreate(48000);
  std::array<float, 480> microphone{}, reference{}, output{};
  if (GBAudioProcessingRenderAtRate(mixed, reference.data(), 12345) != -1) return 5;
  for (int frame = 0; frame < 200; ++frame) {
    for (int i = 0; i < 441; ++i)
      reference[i] = static_cast<float>(0.05 * std::sin((frame * 441 + i) * 600.0 / 44100));
    for (int i = 0; i < 480; ++i)
      microphone[i] = static_cast<float>(0.01 * std::sin((frame * 480 + i) * 1000.0 / 48000));
    if (GBAudioProcessingRenderAtRate(mixed, reference.data(), 44100) != 0 ||
        GBAudioProcessingCapture(mixed, microphone.data(), output.data()) != 0) return 6;
    for (float sample : output) if (!std::isfinite(sample)) return 7;
  }
  GBAudioProcessingDestroy(mixed);
  std::puts("44100 Hz render / 48000 Hz capture passed");
  }
  return 0;
}

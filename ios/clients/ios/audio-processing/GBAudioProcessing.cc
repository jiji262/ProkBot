#include "GBAudioProcessing.h"
#include "webrtc/modules/audio_processing/include/audio_processing.h"
#include "webrtc/api/scoped_refptr.h"
#include "webrtc/modules/audio_processing/aec3/echo_canceller3.h"
#include <algorithm>
#include <array>
#include <new>

namespace {
class ResidualEchoFactory final : public webrtc::EchoControlFactory {
 public:
  std::unique_ptr<webrtc::EchoControl> Create(int rate, int renderChannels,
                                            int captureChannels) override {
    auto configuration = webrtc::EchoCanceller3::CreateDefaultConfig(
        renderChannels, captureChannels);
    configuration.suppressor.dominant_nearend_detection.trigger_threshold = 2;
    return std::make_unique<webrtc::EchoCanceller3>(
        configuration, rate, renderChannels, captureChannels);
  }
};

rtc::scoped_refptr<webrtc::AudioProcessing> CreateAPM(bool residual) {
  webrtc::AudioProcessingBuilder builder;
  if (residual) builder.SetEchoControlFactory(std::make_unique<ResidualEchoFactory>());
  return builder.Create();
}
}  // namespace

struct GBAudioProcessing {
  rtc::scoped_refptr<webrtc::AudioProcessing> apm;
  webrtc::StreamConfig stream;
  std::array<float, 480> rendered{};
  int delay = 0;

  GBAudioProcessing(int rate, bool residual)
      : apm(CreateAPM(residual)), stream(rate, 1) {}
};

static GBAudioProcessing *CreateProcessor(int sampleRate, bool residual) {
  if (sampleRate != 8000 && sampleRate != 16000 && sampleRate != 24000 &&
      sampleRate != 32000 && sampleRate != 44100 && sampleRate != 48000) return nullptr;
  auto *processor = new (std::nothrow) GBAudioProcessing(sampleRate, residual);
  if (!processor || !processor->apm) { delete processor; return nullptr; }
  webrtc::AudioProcessing::Config configuration;
  configuration.echo_canceller.enabled = true;
  configuration.echo_canceller.mobile_mode = false;
  // Clients choose whether this supplements or replaces system processing.
  // Gain control stays disabled; moderate noise suppression is optional.
  configuration.gain_controller1.enabled = false;
  configuration.gain_controller2.enabled = false;
  configuration.noise_suppression.enabled = false;
  processor->apm->ApplyConfig(configuration);
  if (processor->apm->Initialize() != 0) { delete processor; return nullptr; }
  return processor;
}

GBAudioProcessing *GBAudioProcessingCreate(int sampleRate) {
  return CreateProcessor(sampleRate, false);
}

GBAudioProcessing *GBAudioProcessingCreateResidual(int sampleRate) {
  return CreateProcessor(sampleRate, true);
}

void GBAudioProcessingDestroy(GBAudioProcessing *processor) { delete processor; }

int GBAudioProcessingRender(GBAudioProcessing *processor, const float *samples) {
  if (!processor) return -1;
  return GBAudioProcessingRenderAtRate(processor, samples, processor->stream.sample_rate_hz());
}

int GBAudioProcessingRenderAtRate(GBAudioProcessing *processor, const float *samples, int renderRate) {
  if (!processor || !samples) return -1;
  if (renderRate != 8000 && renderRate != 16000 && renderRate != 24000 &&
      renderRate != 32000 && renderRate != 44100 && renderRate != 48000) return -1;
  const webrtc::StreamConfig render(renderRate, 1);
  const float *input[] = {samples};
  float *output[] = {processor->rendered.data()};
  return processor->apm->ProcessReverseStream(input, render, render, output);
}

int GBAudioProcessingCapture(GBAudioProcessing *processor, const float *samples, float *output) {
  if (!processor || !samples || !output) return -1;
  const float *input[] = {samples};
  float *channels[] = {output};
  processor->apm->set_stream_delay_ms(processor->delay);
  return processor->apm->ProcessStream(input, processor->stream, processor->stream, channels);
}

void GBAudioProcessingSetDelay(GBAudioProcessing *processor, int milliseconds) {
  if (processor) processor->delay = std::clamp(milliseconds, 0, 500);
}

void GBAudioProcessingSetNoiseSuppression(GBAudioProcessing *processor, int enabled) {
  if (!processor) return;
  auto configuration = processor->apm->GetConfig();
  configuration.noise_suppression.enabled = enabled != 0;
  configuration.noise_suppression.level = webrtc::AudioProcessing::Config::NoiseSuppression::kModerate;
  processor->apm->ApplyConfig(configuration);
}

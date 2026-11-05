#import "GBVoiceEcho.h"
#import "audio-processing/GBAudioProcessing.h"
#include <stdatomic.h>
#include <math.h>
#include <string.h>
#include <time.h>

#define GB_REFERENCE_CAPACITY 131072
#define GB_MAX_FRAME 480

static _Atomic(uint64_t) GBNearSamples, GBFarSamples, GBMatchedSamples, GBProcessingNanos;
static _Atomic(int64_t) GBInputRate, GBInputFrames, GBOutputRate, GBOutputFrames, GBReferenceTick, GBReferenceDelta;
void GBVoiceEchoStatistics(uint64_t *out) {
  out[0] = atomic_load(&GBNearSamples); out[1] = atomic_load(&GBFarSamples); out[2] = atomic_load(&GBMatchedSamples);
}

void GBVoiceEchoPerformance(uint64_t *out) {
  out[0] = atomic_load(&GBNearSamples); out[1] = atomic_load(&GBProcessingNanos);
}

void GBVoiceEchoTimings(int64_t *out) {
  out[0] = atomic_load(&GBInputRate); out[1] = atomic_load(&GBInputFrames);
  out[2] = atomic_load(&GBOutputRate); out[3] = atomic_load(&GBOutputFrames);
  out[4] = atomic_load(&GBReferenceDelta);
}

@interface GBVoiceEcho () {
  void *_processor;
  int _rate, _frameSize, _filled, _outputAt;
  uint64_t _captureTick;
  float _near[GB_MAX_FRAME], _far[GB_MAX_FRAME], _clean[GB_MAX_FRAME];
  _Atomic(uint64_t) *_tags;
  _Atomic(uint32_t) *_reference;
  _Atomic(int) _renderRate;
  atomic_bool _invalidReference;
}
@end

@implementation GBVoiceEcho
- (instancetype)initWithInputFormat:(AVAudioFormat *)format {
  if (!(self = [super init])) return nil;
  _rate = (int)llround(format.sampleRate);
  if (_rate != 8000 && _rate != 16000 && _rate != 24000 &&
      _rate != 32000 && _rate != 44100 && _rate != 48000) return nil;
  _frameSize = _rate / 100; _outputAt = _frameSize;
  _processor = GBAudioProcessingCreateResidual(_rate);
  if (!_processor) return nil;
  _tags = calloc(GB_REFERENCE_CAPACITY, sizeof(*_tags));
  _reference = calloc(GB_REFERENCE_CAPACITY, sizeof(*_reference));
  if (!_tags || !_reference) return nil;
  // The reference is indexed by AVAudioTime, not callback arrival order.
  // AEC3 subsequently estimates and tracks the room/device delay itself.
  GBAudioProcessingSetDelay(_processor, 30);
  GBAudioProcessingSetNoiseSuppression(_processor, 0);
  return self;
}
- (NSInteger)sampleRate { return _rate; }
- (void)dealloc {
  if (_processor) GBAudioProcessingDestroy(_processor);
  free(_tags); free(_reference);
}
- (void)render:(AVAudioPCMBuffer *)buffer atTime:(AVAudioTime *)time {
  if (!time.isHostTimeValid || !buffer.floatChannelData) { atomic_store(&_invalidReference, true); return; }
  int rate = (int)llround(buffer.format.sampleRate);
  if (rate != 8000 && rate != 16000 && rate != 24000 && rate != 32000 &&
      rate != 44100 && rate != 48000) { atomic_store(&_invalidReference, true); return; }
  unsigned channels = buffer.format.channelCount;
  if (!channels) { atomic_store(&_invalidReference, true); return; }
  atomic_store_explicit(&_renderRate, rate, memory_order_release);
  uint64_t tick = (uint64_t)llround([AVAudioTime secondsForHostTime:time.hostTime] * rate);
  atomic_store(&GBOutputRate, rate); atomic_store(&GBOutputFrames, buffer.frameLength);
  atomic_store(&GBReferenceTick, tick);
  float *const *samples = buffer.floatChannelData;
  BOOL interleaved = buffer.format.isInterleaved;
  atomic_fetch_add(&GBFarSamples, buffer.frameLength);
  // Preserve the original clock and frame count. AVAudioConverter batches do
  // not correspond to a tap's hostTime; indexing those batches introduces gaps.
  for (unsigned i = 0; i < buffer.frameLength; i++) {
    float mono = 0;
    for (unsigned c = 0; c < channels; c++)
      mono += interleaved ? samples[0][i * channels + c] : samples[c][i];
    mono /= channels;
    unsigned slot = (unsigned)((tick + i) & (GB_REFERENCE_CAPACITY - 1));
    uint32_t bits; memcpy(&bits, &mono, sizeof(bits));
    atomic_store_explicit(&_reference[slot], bits, memory_order_relaxed);
    atomic_store_explicit(&_tags[slot], tick + i, memory_order_release);
  }
}

- (BOOL)capture:(AVAudioPCMBuffer *)buffer atTime:(AVAudioTime *)time {
  if (atomic_load(&_invalidReference) || !time.isHostTimeValid || !buffer.floatChannelData || buffer.format.sampleRate != _rate ||
      !buffer.format.channelCount) return NO;
  uint64_t tick = (uint64_t)llround([AVAudioTime secondsForHostTime:time.hostTime] * _rate);
  unsigned channels = buffer.format.channelCount;
  BOOL interleaved = buffer.format.isInterleaved;
  float *const *samples = buffer.floatChannelData;
  atomic_store(&GBInputRate, _rate); atomic_store(&GBInputFrames, buffer.frameLength);
  int renderRate = atomic_load_explicit(&_renderRate, memory_order_acquire);
  if (!renderRate) renderRate = _rate;
  atomic_store(&GBReferenceDelta, (int64_t)llround((double)tick * renderRate / _rate)
    - atomic_load(&GBReferenceTick));
  atomic_fetch_add(&GBNearSamples, buffer.frameLength);
  uint64_t started = clock_gettime_nsec_np(CLOCK_UPTIME_RAW);
  for (unsigned i = 0; i < buffer.frameLength; i++) {
    if (!_filled) _captureTick = tick + i;
    float mono = 0;
    for (unsigned c = 0; c < channels; c++)
      mono += interleaved ? samples[0][i * channels + c] : samples[c][i];
    _near[_filled++] = mono / channels;
    // One 10 ms FIFO preserves all samples even when tap buffers are not an
    // exact number of processing frames. No unprocessed tail is forwarded.
    float output = _outputAt < _frameSize ? _clean[_outputAt++] : 0;
    for (unsigned c = 0; c < channels; c++) {
      if (interleaved) samples[0][i * channels + c] = output; else samples[c][i] = output;
    }
    if (_filled != _frameSize) continue;
    renderRate = atomic_load_explicit(&_renderRate, memory_order_acquire);
    if (!renderRate) renderRate = _rate;
    int renderFrames = renderRate / 100, matchedFrames = 0;
    uint64_t referenceTick = (uint64_t)llround((double)_captureTick * renderRate / _rate);
    for (int j = 0; j < renderFrames; j++) {
      uint64_t at = referenceTick + j - renderRate / 50;
      unsigned slot = (unsigned)(at & (GB_REFERENCE_CAPACITY - 1));
      BOOL matched = atomic_load_explicit(&_tags[slot], memory_order_acquire) == at;
      if (matched) matchedFrames++;
      uint32_t bits = matched ? atomic_load_explicit(&_reference[slot], memory_order_relaxed) : 0;
      memcpy(_far + j, &bits, sizeof(bits));
    }
    // Report matching in capture-equivalent samples for a stable denominator.
    atomic_fetch_add(&GBMatchedSamples, (uint64_t)llround((double)matchedFrames * _rate / renderRate));
    if (GBAudioProcessingRenderAtRate(_processor, _far, renderRate) != 0 ||
        GBAudioProcessingCapture(_processor, _near, _clean) != 0) return NO;
    _filled = 0; _outputAt = 0;
  }
  atomic_fetch_add(&GBProcessingNanos, clock_gettime_nsec_np(CLOCK_UPTIME_RAW) - started);
  return YES;
}
@end

#ifndef GB_AUDIO_PROCESSING_H
#define GB_AUDIO_PROCESSING_H

#ifdef __cplusplus
extern "C" {
#endif

typedef struct GBAudioProcessing GBAudioProcessing;

/* Single-channel float PCM in [-1, 1]. Call serially on one audio queue.
 * Each Render/Capture call contains exactly sampleRate / 100 frames (10 ms).
 * Feed the actual loudspeaker reference to Render before its capture block.
 * Supported sample rates: 8000, 16000, 24000, 32000, 44100, 48000 Hz. */
GBAudioProcessing *GBAudioProcessingCreate(int sampleRate);
/* For capture already processed by a system voice unit. Keeps the default AEC3
 * profile, with faster near-end speech detection to preserve interruption onset. */
GBAudioProcessing *GBAudioProcessingCreateResidual(int sampleRate);
void GBAudioProcessingDestroy(GBAudioProcessing *processor);
int GBAudioProcessingRender(GBAudioProcessing *processor, const float *samples);
/* Render may use a different hardware rate. Supply renderRate / 100 frames;
 * WebRTC performs continuous resampling without callback-boundary gaps. */
int GBAudioProcessingRenderAtRate(GBAudioProcessing *processor, const float *samples, int renderRate);
int GBAudioProcessingCapture(GBAudioProcessing *processor, const float *samples, float *output);
/* Output/input hardware timestamp difference, clamped to APM's 0..500 ms. */
void GBAudioProcessingSetDelay(GBAudioProcessing *processor, int milliseconds);
/* Optional moderate suppression for operation without system voice processing. */
void GBAudioProcessingSetNoiseSuppression(GBAudioProcessing *processor, int enabled);

#ifdef __cplusplus
}
#endif
#endif

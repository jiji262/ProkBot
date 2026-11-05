#import "GBVoiceAudio.h"
#import "GBVoiceEcho.h"
#import "GBDiagnostics.h"
#import "GBLocalize.h"
#import <AVFoundation/AVFoundation.h>
#import <objc/runtime.h>
#import <objc/message.h>
#import <stdatomic.h>

#if !defined(GROKBOT_VOICE_AEC3)
BOOL GBVoiceAudioAvailable(void) { return NO; }
#else
// The original module retains its microphone tap, player, resampler and UI.
// AEC3 uses the same engine's actual output to remove residual speaker echo.
static BOOL GBVoiceAudioInstalled;
static BOOL (*GBOriginalEngineStart)(AVAudioEngine *, SEL, NSError **);
static void (*GBOriginalTap)(AVAudioNode *, SEL, AVAudioNodeBus, AVAudioFrameCount, AVAudioFormat *, AVAudioNodeTapBlock);
static __weak AVAudioEngine *GBCallEngine;
static __weak id GBCallSocket;
static void (*GBOriginalSocketOpen)(id, SEL);
static const void *GBEchoKey = &GBEchoKey;
@interface GBVoiceAudioContext : NSObject { @public atomic_bool failureQueued; }
@property(atomic,strong) GBVoiceEcho *echo;
@property(nonatomic,strong) AVAudioPCMBuffer *captureBuffer;
@property(nonatomic,weak) AVAudioMixerNode *referenceNode;
- (GBVoiceEcho *)echoForFormat:(AVAudioFormat *)format;
- (AVAudioPCMBuffer *)copyCapture:(AVAudioPCMBuffer *)source;
@end
@implementation GBVoiceAudioContext
- (AVAudioPCMBuffer *)copyCapture:(AVAudioPCMBuffer *)source {
  AVAudioPCMBuffer *copy = self.captureBuffer;
  if (!copy || ![copy.format isEqual:source.format] || copy.frameCapacity < source.frameLength) {
    copy = [[AVAudioPCMBuffer alloc] initWithPCMFormat:source.format frameCapacity:source.frameLength];
    self.captureBuffer = copy;
  }
  if (!copy) return nil;
  copy.frameLength = source.frameLength;
  const AudioBufferList *input = source.audioBufferList;
  AudioBufferList *output = copy.mutableAudioBufferList;
  if (input->mNumberBuffers != output->mNumberBuffers) return nil;
  for (UInt32 i = 0; i < input->mNumberBuffers; i++) {
    if (input->mBuffers[i].mDataByteSize > output->mBuffers[i].mDataByteSize) return nil;
    memcpy(output->mBuffers[i].mData, input->mBuffers[i].mData, input->mBuffers[i].mDataByteSize);
  }
  return copy;
}
- (GBVoiceEcho *)echoForFormat:(AVAudioFormat *)format {
  GBVoiceEcho *echo = self.echo;
  if (echo.sampleRate == (NSInteger)llround(format.sampleRate)) return echo;
  @synchronized (self) {
    echo = self.echo;
    if (echo.sampleRate != (NSInteger)llround(format.sampleRate)) {
      echo = [[GBVoiceEcho alloc] initWithInputFormat:format]; self.echo = echo;
    }
  }
  return echo;
}
@end

static BOOL GBIsVoiceSession(void) {
  return [AVAudioSession.sharedInstance.mode isEqual:AVAudioSessionModeVoiceChat];
}
static GBVoiceAudioContext *GBContextForEngine(AVAudioEngine *engine) {
  GBVoiceAudioContext *context = objc_getAssociatedObject(engine, GBEchoKey);
  if (!context) {
    context = [GBVoiceAudioContext new];
    objc_setAssociatedObject(engine, GBEchoKey, context, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
  }
  return context;
}
static void GBOpenVoiceSocket(id socket, SEL selector) {
  NSURL *url = ((id (*)(id, SEL))objc_msgSend)(socket, @selector(url));
  if ([url.path isEqualToString:@"/local/voice/realtime"]) GBCallSocket = socket;
  GBOriginalSocketOpen(socket, selector);
}
static void GBFailVoiceAudio(AVAudioEngine *engine, GBVoiceAudioContext *context) {
  if (atomic_exchange(&context->failureQueued, true)) return;
  // Audio taps must not stop their own engine. The original realtime socket's
  // close event already ends the call and updates the original React UI.
  id socket = GBCallSocket;
  dispatch_async(dispatch_get_main_queue(), ^{
    [engine stop];
    if ([socket respondsToSelector:@selector(closeWithCode:reason:)]) {
      ((void (*)(id, SEL, NSInteger, NSString *))objc_msgSend)(socket,
        @selector(closeWithCode:reason:), 1011,
        GBL(@"语音处理已中断，请重新连接。", @"Voice audio stopped. Please reconnect."));
    }
    GBDiagnosticsEvent(@"voice.audio.unavailable", @{});
  });
}
static BOOL GBConfigureVoiceEngine(AVAudioEngine *engine) {
  if (!GBIsVoiceSession() || !engine.inputNode.isVoiceProcessingEnabled) return NO;
  engine.inputNode.voiceProcessingBypassed = NO;
  GBVoiceAudioContext *context = GBContextForEngine(engine);
  GBVoiceEcho *echo = [context echoForFormat:[engine.inputNode outputFormatForBus:0]];
  if (!echo) return NO;
  AVAudioMixerNode *mixer = engine.mainMixerNode;
  if (context.referenceNode != mixer) {
    GBOriginalTap(mixer, @selector(installTapOnBus:bufferSize:format:block:), 0, 480, nil,
      ^(AVAudioPCMBuffer *buffer, AVAudioTime *time) { [context.echo render:buffer atTime:time]; });
    context.referenceNode = mixer;
  }
  GBCallEngine = engine;
  return YES;
}
static BOOL GBStartVoiceEngine(AVAudioEngine *engine, SEL selector, NSError **error) {
  BOOL voice = GBIsVoiceSession(), configured = voice && GBConfigureVoiceEngine(engine);
  if (configured) atomic_store(&GBContextForEngine(engine)->failureQueued, false);
  if (voice && !configured) {
    if (error) *error = [NSError errorWithDomain:@"GrokBotVoiceAudio" code:1
      userInfo:@{NSLocalizedDescriptionKey:GBL(@"无法启动语音处理。", @"Voice audio processing could not start.")}];
    return NO;
  }
  BOOL started = GBOriginalEngineStart(engine, selector, error);
  if (configured) {
    AVAudioSession *session = AVAudioSession.sharedInstance;
    GBDiagnosticsEvent(@"voice.audio.native", @{
      @"running":@(started), @"voiceProcessing":@(engine.inputNode.isVoiceProcessingEnabled),
      @"bypassed":@(engine.inputNode.isVoiceProcessingBypassed), @"residualProcessing":@"aec3",
      @"automaticGain":@(engine.inputNode.isVoiceProcessingAGCEnabled),
      @"sampleRate":@(session.sampleRate), @"ioBufferSeconds":@(session.IOBufferDuration),
      @"input":session.currentRoute.inputs.firstObject.portType ?: @"",
      @"output":session.currentRoute.outputs.firstObject.portType ?: @""
    });
  }
  return started;
}
static void GBInstallInputTap(AVAudioNode *node, SEL selector, AVAudioNodeBus bus,
    AVAudioFrameCount size, AVAudioFormat *format, AVAudioNodeTapBlock block) {
  if (![node isKindOfClass:AVAudioInputNode.class] || !GBIsVoiceSession()) {
    GBOriginalTap(node, selector, bus, size, format, block); return;
  }
  GBVoiceAudioContext *context = GBContextForEngine(node.engine);
  __weak AVAudioEngine *engine = node.engine;
  GBOriginalTap(node, selector, bus, size, format, ^(AVAudioPCMBuffer *buffer, AVAudioTime *when) {
    GBVoiceEcho *echo = [context echoForFormat:buffer.format];
    // The system owns tap storage. Keep its audio intact; the original
    // resampler consumes our reusable processed copy synchronously.
    AVAudioPCMBuffer *processed = [context copyCapture:buffer];
    if (!echo || !processed || ![echo capture:processed atTime:when]) { GBFailVoiceAudio(engine, context); return; }
    block(processed, when);
  });
}
BOOL GBVoiceAudioAvailable(void) { return GBVoiceAudioInstalled; }
__attribute__((constructor)) static void GBInstallVoiceAudio(void) {
  Method start = class_getInstanceMethod(AVAudioEngine.class, @selector(startAndReturnError:));
  Method tap = class_getInstanceMethod(AVAudioNode.class, @selector(installTapOnBus:bufferSize:format:block:));
  if (!start || !tap) return;
  GBOriginalEngineStart = (void *)method_setImplementation(start, (IMP)GBStartVoiceEngine);
  GBOriginalTap = (void *)method_setImplementation(tap, (IMP)GBInstallInputTap);
  Class socketClass = NSClassFromString(@"SRWebSocket");
  Method open = class_getInstanceMethod(socketClass, @selector(open));
  if (open) GBOriginalSocketOpen = (void *)method_setImplementation(open, (IMP)GBOpenVoiceSocket);
  GBVoiceAudioInstalled = YES;
  [NSNotificationCenter.defaultCenter addObserverForName:AVAudioEngineConfigurationChangeNotification
    object:nil queue:NSOperationQueue.mainQueue usingBlock:^(NSNotification *notification) {
      AVAudioEngine *engine = notification.object;
      GBVoiceAudioContext *context = objc_getAssociatedObject(engine, GBEchoKey);
      // This notification also arrives after AVAudioEngine's native graph has
      // been disposed. Never query nodes or change taps from this deferred
      // callback. The next explicit start compares the live mixer identity.
      context.echo = nil;
    }];
  [NSNotificationCenter.defaultCenter addObserverForName:AVAudioSessionRouteChangeNotification
    object:nil queue:NSOperationQueue.mainQueue usingBlock:^(NSNotification *notification) {
      AVAudioEngine *engine = GBCallEngine;
      // A new speaker/microphone route changes the acoustic path even if its
      // sample rate is unchanged. Rebuild the filter and timestamp ring.
      if (engine) GBContextForEngine(engine).echo = nil;
    }];
}

#endif

#import <AVFoundation/AVFoundation.h>

// AEC3 fallback used when native speaker processing leaves audible echo.
@interface GBVoiceEcho : NSObject
@property(nonatomic,readonly) NSInteger sampleRate;
- (instancetype)initWithInputFormat:(AVAudioFormat *)format;
- (void)render:(AVAudioPCMBuffer *)buffer atTime:(AVAudioTime *)time;
- (BOOL)capture:(AVAudioPCMBuffer *)buffer atTime:(AVAudioTime *)time;
@end

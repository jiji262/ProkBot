#import "GBSpeech.h"
#import "GBConnection.h"
#import "GBHTTP.h"
#import "GBDiagnostics.h"
#import "GBLocalize.h"

@interface GBSpeechProtocol : NSURLProtocol
@property(nonatomic,strong) NSURLSessionDataTask *task;
@property(nonatomic,assign) BOOL cancelled;
@end

@implementation GBSpeechProtocol
+ (BOOL)canInitWithRequest:(NSURLRequest *)request {
  return [request.HTTPMethod isEqual:@"POST"] &&
    [request.URL.path isEqual:@"/aiserver.v1.AiService/TranscribeAudio"];
}
+ (NSURLRequest *)canonicalRequestForRequest:(NSURLRequest *)request { return request; }
- (void)fail:(NSString *)message code:(NSInteger)code {
  NSError *error = [NSError errorWithDomain:@"GrokBotSpeech" code:code userInfo:@{NSLocalizedDescriptionKey:message}];
  [self.client URLProtocol:self didFailWithError:error];
}
- (void)startLoading {
  GBConnection *connection = GBConnection.shared;
  if (!connection.deviceToken.length || !connection.serverURL.length) {
    [self fail:GBL(@"请先连接 Host。", @"Connect to Host first.") code:401]; return;
  }
  NSData *body = self.request.HTTPBody;
  if (!body && self.request.HTTPBodyStream) {
    NSInputStream *stream = self.request.HTTPBodyStream;
    NSMutableData *collected = [NSMutableData data];
    uint8_t buffer[16384]; NSInteger count;
    [stream open];
    while ((count = [stream read:buffer maxLength:sizeof(buffer)]) > 0) {
      if (collected.length + count > 36 * 1024 * 1024) {
        [stream close]; [self fail:GBL(@"录音文件过大。", @"The recording is too large.") code:413]; return;
      }
      [collected appendBytes:buffer length:count];
    }
    [stream close];
    if (count < 0) { [self fail:GBL(@"无法读取录音。", @"Could not read the recording.") code:400]; return; }
    body = collected;
  }
  id parsed = body ? [NSJSONSerialization JSONObjectWithData:body options:0 error:nil] : nil;
  if (![parsed isKindOfClass:NSDictionary.class] || ![parsed[@"audio"] isKindOfClass:NSString.class]) {
    [self fail:GBL(@"无法读取录音。", @"Could not read the recording.") code:400]; return;
  }
  NSMutableDictionary *payload = [NSMutableDictionary dictionaryWithDictionary:parsed];
  payload[@"audioBase64"] = payload[@"audio"]; [payload removeObjectForKey:@"audio"];
  NSMutableURLRequest *request = [NSMutableURLRequest requestWithURL:[NSURL URLWithString:
    [connection.serverURL stringByAppendingString:@"/local/audio/transcriptions"]]];
  request.HTTPMethod = @"POST";
  request.allHTTPHeaderFields = @{@"Content-Type":@"application/json", @"Accept":@"application/json",
    @"Authorization":[@"Bearer " stringByAppendingString:connection.deviceToken]};
  request.timeoutInterval = 125;
  request.HTTPBody = [NSJSONSerialization dataWithJSONObject:payload options:0 error:nil];
  GBDiagnosticsEvent(@"speech.request", @{@"mimeType":payload[@"mimeType"] ?: @"", @"bytes":@(body.length)});
  self.task = [GBHTTPSession() dataTaskWithRequest:request completionHandler:^(NSData *data, NSURLResponse *response, NSError *error) {
    if (self.cancelled) return;
    if (error) { [self.client URLProtocol:self didFailWithError:error]; return; }
    NSHTTPURLResponse *http = (NSHTTPURLResponse *)response;
    GBDiagnosticsEvent(@"speech.response", @{@"status":@(http.statusCode)});
    NSHTTPURLResponse *original = [[NSHTTPURLResponse alloc] initWithURL:self.request.URL
      statusCode:http.statusCode HTTPVersion:@"HTTP/1.1" headerFields:http.allHeaderFields];
    [self.client URLProtocol:self didReceiveResponse:original cacheStoragePolicy:NSURLCacheStorageNotAllowed];
    if (data.length) [self.client URLProtocol:self didLoadData:data];
    [self.client URLProtocolDidFinishLoading:self];
  }];
  [self.task resume];
}
- (void)stopLoading { self.cancelled = YES; [self.task cancel]; }
@end
Class GBSpeechProtocolClass(void) { return GBSpeechProtocol.class; }

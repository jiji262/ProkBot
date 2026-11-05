#import "GBAppIntents.h"
#import "GBConnection.h"
#import "GBHTTP.h"
#import "GBDiagnostics.h"
#import "GBLocalize.h"
#import <Security/Security.h>

// The original Swift App Intents read this Expo SecureStore item directly,
// independently of the React Native account state. Keep the original intent
// implementation and give it a local identity; the transport owns device auth.
void GBSyncAppIntentCredentials(void) {
  NSDictionary *query = @{
    (__bridge id)kSecClass: (__bridge id)kSecClassGenericPassword,
    (__bridge id)kSecAttrService: @"app:no-auth",
    (__bridge id)kSecAttrAccount: @"sand.cursor-tokens"
  };
  GBConnection *connection = GBConnection.shared;
  if (!connection.serverURL.length || !connection.deviceToken.length) {
    SecItemDelete((__bridge CFDictionaryRef)query);
    return;
  }
  // Original Swift code derives the account ID from a JWT payload. This is an
  // unsigned local marker, not an authentication credential. Real device auth
  // is attached only by the local transport below.
  NSString *(^base64url)(NSDictionary *) = ^NSString *(NSDictionary *value) {
    NSString *encoded = [[NSJSONSerialization dataWithJSONObject:value options:0 error:nil] base64EncodedStringWithOptions:0];
    return [[[encoded stringByReplacingOccurrencesOfString:@"+" withString:@"-"]
      stringByReplacingOccurrencesOfString:@"/" withString:@"_"] stringByReplacingOccurrencesOfString:@"=" withString:@""];
  };
  NSString *marker = [NSString stringWithFormat:@"%@.%@.local", base64url(@{@"alg":@"none",@"typ":@"JWT"}),
    base64url(@{@"sub":@"grokbot-local",@"email":@"local@workspace.invalid"})];
  NSData *data = [NSJSONSerialization dataWithJSONObject:@{
    @"accessToken": marker,
    @"backendUrl": connection.serverURL
  } options:0 error:nil];
  NSDictionary *attributes = @{
    (__bridge id)kSecValueData: data,
    (__bridge id)kSecAttrAccessible: (__bridge id)kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
  };
  OSStatus status = SecItemUpdate((__bridge CFDictionaryRef)query, (__bridge CFDictionaryRef)attributes);
  if (status == errSecItemNotFound) {
    NSMutableDictionary *item = [query mutableCopy];
    [item addEntriesFromDictionary:attributes];
    status = SecItemAdd((__bridge CFDictionaryRef)item, NULL);
  }
  GBDiagnosticsEvent(@"app-intents.credentials", @{@"status":@(status)});
}

static NSString *GBIntentMethod(NSURLRequest *request) {
  if (![request.HTTPMethod isEqual:@"POST"]) return nil;
  NSString *prefix = @"/aiserver.v1.GrokBotService/";
  if (![request.URL.path hasPrefix:prefix]) return nil;
  NSString *method = [request.URL.path substringFromIndex:prefix.length];
  return [@[@"ListGrokBotAgents", @"SendGrokBotUserMessage", @"GetGrokBotSendStatus"] containsObject:method] ? method : nil;
}

@interface GBAppIntentsProtocol : NSURLProtocol
@property(nonatomic, strong) NSURLSessionDataTask *task;
@property(nonatomic, assign) BOOL cancelled;
@end

@implementation GBAppIntentsProtocol
+ (BOOL)canInitWithRequest:(NSURLRequest *)request { return GBIntentMethod(request) != nil; }
+ (NSURLRequest *)canonicalRequestForRequest:(NSURLRequest *)request { return request; }
- (void)fail:(NSString *)message code:(NSInteger)code {
  [self.client URLProtocol:self didFailWithError:[NSError errorWithDomain:@"GrokBotAppIntents"
    code:code userInfo:@{NSLocalizedDescriptionKey:message}]];
}
- (void)startLoading {
  GBConnection *connection = GBConnection.shared;
  if (!connection.serverURL.length || !connection.deviceToken.length) {
    [self fail:GBL(@"请先连接 Host。", @"Connect to Host first.") code:401];
    return;
  }
  NSData *body = self.request.HTTPBody;
  if (!body && self.request.HTTPBodyStream) {
    NSInputStream *stream = self.request.HTTPBodyStream;
    NSMutableData *collected = [NSMutableData new];
    uint8_t buffer[8192]; NSInteger count;
    [stream open];
    while ((count = [stream read:buffer maxLength:sizeof(buffer)]) > 0) {
      if (collected.length + count > 1024 * 1024) {
        [stream close]; [self fail:GBL(@"消息过长。", @"Message is too long.") code:413]; return;
      }
      [collected appendBytes:buffer length:count];
    }
    [stream close];
    if (count < 0) { [self fail:GBL(@"无法读取消息。", @"Could not read the message.") code:400]; return; }
    body = collected;
  }
  NSString *method = GBIntentMethod(self.request);
  NSMutableURLRequest *request = [NSMutableURLRequest requestWithURL:[NSURL URLWithString:
    [connection.serverURL stringByAppendingFormat:@"/local/app-intents/%@", method]]];
  request.HTTPMethod = @"POST";
  request.HTTPBody = body ?: [@"{}" dataUsingEncoding:NSUTF8StringEncoding];
  request.allHTTPHeaderFields = @{@"Content-Type":@"application/json", @"Accept":@"application/json",
    @"Authorization":[@"Bearer " stringByAppendingString:connection.deviceToken]};
  request.timeoutInterval = 30;
  GBDiagnosticsEvent(@"app-intents.request", @{@"method":method});
  self.task = [GBHTTPSession() dataTaskWithRequest:request completionHandler:^(NSData *data, NSURLResponse *response, NSError *error) {
    if (self.cancelled) return;
    if (error) { [self.client URLProtocol:self didFailWithError:error]; return; }
    NSHTTPURLResponse *http = (NSHTTPURLResponse *)response;
    GBDiagnosticsEvent(@"app-intents.response", @{@"method":method, @"status":@(http.statusCode)});
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

Class GBAppIntentsProtocolClass(void) { return GBAppIntentsProtocol.class; }

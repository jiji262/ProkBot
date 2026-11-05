#import "GBConnectors.h"
#import "GBConnection.h"
#import "GBHTTP.h"
#import "GBPrivacy.h"
#import "GBSpeech.h"
#import "GBVoice.h"
#import "GBAppIntents.h"
#import "GBSharing.h"
#import <objc/runtime.h>

static NSSet *GBConnectorMethods(void) {
  static NSSet *methods; static dispatch_once_t once;
  dispatch_once(&once, ^{ methods = [NSSet setWithArray:@[
    @"ListMarketplacePlugins", @"ListPrivateMarketplacePlugins", @"ListMarketplaces", @"GetEffectiveUserPlugins",
    @"GetAvailableMcpServers", @"ListSandMcpTools", @"ValidateMcpOAuthTokens",
    @"InstallUserPlugin", @"UninstallUserPlugin", @"UpdateUserPlugin", @"UpdateUserPluginVariables",
    @"RenameMcpOAuthAccount", @"DeleteMcpOAuthAccount", @"CheckHttpMcpStatus",
    @"CompleteMcpOAuth", @"GetPluginDetails", @"GetGrokBotMcpToolPermissions",
    @"SetGrokBotMcpToolPermissions"
  ]]; }); return methods;
}
static NSString *GBConnectorMethod(NSURLRequest *request) {
  NSString *path = request.URL.path;
  NSRange service = [path rangeOfString:@"/aiserver.v1.DashboardService/"];
  if (service.location == NSNotFound || ![request.HTTPMethod isEqual:@"POST"]) return nil;
  NSString *method = [path substringFromIndex:NSMaxRange(service)];
  return [GBConnectorMethods() containsObject:method] ? method : nil;
}
@interface GBConnectorProtocol : NSURLProtocol
@property(nonatomic,strong) NSURLSessionDataTask *task;
@property(nonatomic,assign) BOOL cancelled;
@end
@implementation GBConnectorProtocol
+ (BOOL)canInitWithRequest:(NSURLRequest *)request {
  return GBConnection.shared.deviceToken.length && GBConnectorMethod(request) != nil;
}
+ (NSURLRequest *)canonicalRequestForRequest:(NSURLRequest *)request { return request; }
- (void)startLoading {
  NSString *method = GBConnectorMethod(self.request);
  NSString *path = [@"/local/mobile-rpc/" stringByAppendingString:method];
  NSMutableURLRequest *request = [self.request mutableCopy];
  request.URL = [NSURL URLWithString:[GBConnection.shared.serverURL stringByAppendingString:path]];
  request.allHTTPHeaderFields = @{ @"Content-Type": @"application/json", @"Accept": @"application/json",
    @"Authorization": [@"Bearer " stringByAppendingString:GBConnection.shared.deviceToken] };
  request.timeoutInterval = 30;
  self.task = [GBHTTPSession() dataTaskWithRequest:request completionHandler:^(NSData *data, NSURLResponse *response, NSError *error) {
    if (self.cancelled) return;
    if (error) { [self.client URLProtocol:self didFailWithError:error]; return; }
    NSHTTPURLResponse *http = (NSHTTPURLResponse *)response;
    NSHTTPURLResponse *originalURLResponse = [[NSHTTPURLResponse alloc] initWithURL:self.request.URL statusCode:http.statusCode HTTPVersion:@"HTTP/1.1" headerFields:http.allHeaderFields];
    [self.client URLProtocol:self didReceiveResponse:originalURLResponse cacheStoragePolicy:NSURLCacheStorageNotAllowed];
    if (data.length) [self.client URLProtocol:self didLoadData:data];
    [self.client URLProtocolDidFinishLoading:self];
  }];
  [self.task resume];
}
- (void)stopLoading { self.cancelled = YES; [self.task cancel]; }
@end
static IMP GBDefaultConfig, GBEphemeralConfig;
static NSURLSessionConfiguration *GBAddProtocol(NSURLSessionConfiguration *config) {
  NSMutableArray *classes = [config.protocolClasses mutableCopy] ?: [NSMutableArray new];
  if (![classes containsObject:GBConnectorProtocol.class]) [classes insertObject:GBConnectorProtocol.class atIndex:0];
  if (![classes containsObject:GBPrivacyProtocolClass()]) [classes insertObject:GBPrivacyProtocolClass() atIndex:0];
  if (![classes containsObject:GBSpeechProtocolClass()]) [classes insertObject:GBSpeechProtocolClass() atIndex:0];
  if (![classes containsObject:GBVoiceProtocolClass()]) [classes insertObject:GBVoiceProtocolClass() atIndex:0];
  if (![classes containsObject:GBAppIntentsProtocolClass()]) [classes insertObject:GBAppIntentsProtocolClass() atIndex:0];
  if (![classes containsObject:GBSharingProtocolClass()]) [classes insertObject:GBSharingProtocolClass() atIndex:0];
  config.protocolClasses = classes; return config;
}
static id GBDefault(id self,SEL selector) { return GBAddProtocol(((id(*)(id,SEL))GBDefaultConfig)(self,selector)); }
static id GBEphemeral(id self,SEL selector) { return GBAddProtocol(((id(*)(id,SEL))GBEphemeralConfig)(self,selector)); }
void GBInstallConnectorTransport(void) {
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    [NSURLProtocol registerClass:GBConnectorProtocol.class];
    [NSURLProtocol registerClass:GBPrivacyProtocolClass()];
    [NSURLProtocol registerClass:GBSpeechProtocolClass()];
    [NSURLProtocol registerClass:GBVoiceProtocolClass()];
    [NSURLProtocol registerClass:GBAppIntentsProtocolClass()];
    [NSURLProtocol registerClass:GBSharingProtocolClass()];
    Method a=class_getClassMethod(NSURLSessionConfiguration.class,@selector(defaultSessionConfiguration));
    Method b=class_getClassMethod(NSURLSessionConfiguration.class,@selector(ephemeralSessionConfiguration));
    GBDefaultConfig=method_setImplementation(a,(IMP)GBDefault);
    GBEphemeralConfig=method_setImplementation(b,(IMP)GBEphemeral);
  });
}

#import "GBPrivacy.h"
#import "GBDiagnostics.h"

// The JS patch prevents SDK initialization. This transport filter also prevents
// a native SDK from flushing a queue saved by an earlier installed build.
@interface GBPrivacyProtocol : NSURLProtocol
@end
@implementation GBPrivacyProtocol
+ (BOOL)canInitWithRequest:(NSURLRequest *)request {
  NSString *host = request.URL.host.lowercaseString;
  for (NSString *domain in @[@"sentry.io", @"braze.com", @"appboy.com", @"appsflyer.com", @"appsflyersdk.com", @"statsig.com", @"statsigcdn.com", @"statsigapi.net"]) {
    if ([host isEqual:domain] || [host hasSuffix:[@"." stringByAppendingString:domain]]) return YES;
  }
  return [@[@"/aiserver.v1.AnalyticsService/TrackEvents", @"/aiserver.v1.AnalyticsService/SubmitLogs"] containsObject:request.URL.path];
}
+ (NSURLRequest *)canonicalRequestForRequest:(NSURLRequest *)request { return request; }
- (void)startLoading {
  GBDiagnosticsEvent(@"telemetry.blocked", @{@"host":self.request.URL.host ?: @"", @"path":self.request.URL.path ?: @""});
  NSHTTPURLResponse *response = [[NSHTTPURLResponse alloc] initWithURL:self.request.URL statusCode:204 HTTPVersion:@"HTTP/1.1" headerFields:@{}];
  [self.client URLProtocol:self didReceiveResponse:response cacheStoragePolicy:NSURLCacheStorageNotAllowed];
  [self.client URLProtocolDidFinishLoading:self];
}
- (void)stopLoading {}
@end
Class GBPrivacyProtocolClass(void) { return GBPrivacyProtocol.class; }

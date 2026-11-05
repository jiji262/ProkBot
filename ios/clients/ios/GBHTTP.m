#import "GBHTTP.h"
@interface GBNoRedirect : NSObject <NSURLSessionTaskDelegate>
@end
@implementation GBNoRedirect
- (void)URLSession:(NSURLSession *)session
                          task:(NSURLSessionTask *)task
    willPerformHTTPRedirection:(NSHTTPURLResponse *)response
                    newRequest:(NSURLRequest *)request
             completionHandler:(void (^)(NSURLRequest *))completionHandler {
  completionHandler(nil);
}
@end
NSURLSession *GBHTTPSession(void) {
  static NSURLSession *session;
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    NSURLSessionConfiguration *config = NSURLSessionConfiguration.ephemeralSessionConfiguration;
    config.HTTPCookieAcceptPolicy = NSHTTPCookieAcceptPolicyNever;
    config.HTTPShouldSetCookies = NO;
    session = [NSURLSession sessionWithConfiguration:config
                                            delegate:[GBNoRedirect new]
                                       delegateQueue:nil];
  });
  return session;
}

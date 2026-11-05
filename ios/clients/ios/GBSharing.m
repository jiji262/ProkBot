#import "GBSharing.h"
#import "GBConnection.h"
#import "GBHTTP.h"

// The original React Native SkillSheet owns presentation. This protocol only
// authenticates its small publication API against the paired Host.
@interface GBSharingProtocol : NSURLProtocol
@property(nonatomic,strong) NSURLSessionDataTask *task;
@property(nonatomic,assign) BOOL cancelled;
@end
@implementation GBSharingProtocol
+ (BOOL)canInitWithRequest:(NSURLRequest *)request {
  return [request.URL.scheme isEqual:@"https"] && [request.URL.host isEqual:@"grokbot.local"] &&
    [request.URL.path isEqual:@"/skill-publication"];
}
+ (NSURLRequest *)canonicalRequestForRequest:(NSURLRequest *)request { return request; }
- (void)finish:(NSDictionary *)value {
  if (self.cancelled) return;
  NSData *data = [NSJSONSerialization dataWithJSONObject:value options:0 error:nil];
  NSHTTPURLResponse *response = [[NSHTTPURLResponse alloc] initWithURL:self.request.URL statusCode:200 HTTPVersion:@"HTTP/1.1" headerFields:@{@"Content-Type":@"application/json"}];
  [self.client URLProtocol:self didReceiveResponse:response cacheStoragePolicy:NSURLCacheStorageNotAllowed];
  [self.client URLProtocol:self didLoadData:data];
  [self.client URLProtocolDidFinishLoading:self];
}
- (void)startLoading {
  NSString *server = [GBConnection.shared.serverURL copy];
  NSString *token = [GBConnection.shared.deviceToken copy];
  NSData *body = self.request.HTTPBody;
  if (!body && self.request.HTTPBodyStream) {
    NSInputStream *stream = self.request.HTTPBodyStream; NSMutableData *buffer = [NSMutableData new];
    [stream open]; uint8_t bytes[1024]; NSInteger count;
    while ((count = [stream read:bytes maxLength:sizeof(bytes)]) > 0 && buffer.length <= 8192) [buffer appendBytes:bytes length:(NSUInteger)count];
    [stream close];
    if (count < 0 || buffer.length > 8192) { [self finish:@{@"error":@"Invalid request"}]; return; }
    body = buffer;
  }
  id input = body.length <= 8192 ? [NSJSONSerialization JSONObjectWithData:body ?: NSData.data options:0 error:nil] : nil;
  NSDictionary *args = [input isKindOfClass:NSDictionary.class] ? input : @{};
  NSString *method = [args[@"method"] isKindOfClass:NSString.class] ? args[@"method"] : @"";
  NSString *workflow = [args[@"workflowId"] isKindOfClass:NSString.class] ? args[@"workflowId"] : @"";
  NSDictionary *methods = @{@"status":@"getAgentWorkflows", @"publish":@"publishSkill", @"sync":@"resyncPublishedSkill", @"unpublish":@"unpublishSkill"};
  NSCharacterSet *allowed = [NSCharacterSet characterSetWithCharactersInString:@"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-"];
  BOOL status = [method isEqual:@"status"];
  NSString *agent = [args[@"agentId"] isKindOfClass:NSString.class] ? args[@"agentId"] : @"";
  if (![self.request.HTTPMethod isEqual:@"POST"] || !methods[method] || !workflow.length || workflow.length > 128 ||
      [workflow rangeOfCharacterFromSet:allowed.invertedSet].location != NSNotFound ||
      (status && ![[NSUUID alloc] initWithUUIDString:agent]) || !token.length) {
    [self finish:@{@"error":@"Invalid request"}]; return;
  }
  NSURL *url = [NSURL URLWithString:[server stringByAppendingFormat:@"/api/%@", methods[method]]];
  if (!url.host.length || ![@[@"http",@"https"] containsObject:url.scheme] || url.user || url.password) { [self finish:@{@"error":@"Not connected"}]; return; }
  NSMutableURLRequest *request = [NSMutableURLRequest requestWithURL:url];
  request.HTTPMethod = @"POST"; request.timeoutInterval = 30;
  request.allHTTPHeaderFields = @{@"Content-Type":@"application/json", @"Authorization":[@"Bearer " stringByAppendingString:token]};
  request.HTTPBody = [NSJSONSerialization dataWithJSONObject:status ? @{@"id":agent} : @{@"workflowId":workflow,@"teamId":@1} options:0 error:nil];
  self.task = [GBHTTPSession() dataTaskWithRequest:request completionHandler:^(NSData *data, NSURLResponse *response, NSError *error) {
    if (self.cancelled) return;
    NSInteger code = [(NSHTTPURLResponse *)response statusCode];
    id result = data ? [NSJSONSerialization JSONObjectWithData:data options:0 error:nil] : nil;
    if (error || code < 200 || code >= 300 || !result) { [self finish:@{@"error":@"Request failed"}]; return; }
    if (status) {
      if (![result isKindOfClass:NSArray.class]) { [self finish:@{@"error":@"Invalid response"}]; return; }
      for (id row in result) if ([row isKindOfClass:NSDictionary.class] && [row[@"id"] isEqual:workflow]) {
        [self finish:@{@"published":@([row[@"publishedByCurrentUser"] boolValue])}]; return;
      }
      [self finish:@{@"error":@"Skill not found"}]; return;
    }
    [self finish:@{@"published":@(![method isEqual:@"unpublish"])}];
  }];
  [self.task resume];
}
- (void)stopLoading { self.cancelled = YES; [self.task cancel]; }
@end
Class GBSharingProtocolClass(void) { return GBSharingProtocol.class; }

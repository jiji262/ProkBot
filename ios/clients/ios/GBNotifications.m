#import "GBNotifications.h"
#import "GBConnection.h"
#import "GBPush.h"
#import <UserNotifications/UserNotifications.h>

@interface GBNotifications () <NSURLSessionDataDelegate, UNUserNotificationCenterDelegate>
@property(nonatomic, strong) NSURLSession *session;
@property(nonatomic, strong) NSURLSessionDataTask *task;
@property(nonatomic, strong) NSMutableData *buffer;
@property(nonatomic, assign) NSUInteger generation;
@property(nonatomic, strong) NSString *eventId;
@property(nonatomic, strong) NSString *eventType;
@property(nonatomic, strong) NSMutableArray *eventLines;
@end
@implementation GBNotifications
+ (instancetype)shared {
  static GBNotifications *v;
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    v = [self new];
  });
  return v;
}
- (void)stop {
  self.generation++;
  [self.task cancel];
  self.task = nil;
  [self.session invalidateAndCancel];
  self.session = nil;
  self.buffer = nil;
}
- (void)start {
  NSString *base = GBConnection.shared.serverURL;
  NSString *authorization = [@"Bearer " stringByAppendingString:GBConnection.shared.deviceToken ?: @""];
  if (self.task.state == NSURLSessionTaskStateRunning && self.task &&
      [self.task.originalRequest.URL.absoluteString isEqual:[base stringByAppendingString:@"/notifications/events"]] &&
      [[self.task.originalRequest valueForHTTPHeaderField:@"Authorization"] isEqual:authorization]) return;
  [self stop];
  if (!GBConnection.shared.deviceToken.length ||
      UIApplication.sharedApplication.applicationState != UIApplicationStateActive)
    return;
  self.buffer = [NSMutableData data];
  self.eventLines = [NSMutableArray array];
  NSURLSessionConfiguration *config = NSURLSessionConfiguration.ephemeralSessionConfiguration;
  config.timeoutIntervalForRequest = 120;
  config.timeoutIntervalForResource = 86400;
  self.session = [NSURLSession sessionWithConfiguration:config
                                               delegate:self
                                          delegateQueue:NSOperationQueue.mainQueue];
  NSMutableURLRequest *request = [NSMutableURLRequest
      requestWithURL:[NSURL URLWithString:[GBConnection.shared.serverURL
                                              stringByAppendingString:@"/notifications/events"]]];
  [request setValue:[@"Bearer " stringByAppendingString:GBConnection.shared.deviceToken]
      forHTTPHeaderField:@"Authorization"];
  [request setValue:@"text/event-stream" forHTTPHeaderField:@"Accept"];
  [request setValue:@"1" forHTTPHeaderField:@"X-GrokBot-Foreground"];
  NSString *last =
      [[NSUserDefaults.standardUserDefaults dictionaryForKey:@"GrokBotLocal.notificationCursor"]
          objectForKey:GBConnection.shared.serverURL];
  if (last.length)
    [request setValue:last forHTTPHeaderField:@"Last-Event-ID"];
  self.task = [self.session dataTaskWithRequest:request];
  [self.task resume];
}
- (void)URLSession:(NSURLSession *)session
                          task:(NSURLSessionTask *)task
    willPerformHTTPRedirection:(NSHTTPURLResponse *)response
                    newRequest:(NSURLRequest *)request
             completionHandler:(void (^)(NSURLRequest *))completionHandler {
  completionHandler(nil);
}
- (void)URLSession:(NSURLSession *)session
              dataTask:(NSURLSessionDataTask *)task
    didReceiveResponse:(NSURLResponse *)response
     completionHandler:(void (^)(NSURLSessionResponseDisposition))completionHandler {
  NSInteger status = ((NSHTTPURLResponse *)response).statusCode;
  if (status == 401) {
    completionHandler(NSURLSessionResponseCancel);
    [self stop];
    [GBConnection.shared show];
    return;
  }
  completionHandler(status == 200 ? NSURLSessionResponseAllow : NSURLSessionResponseCancel);
}
- (void)URLSession:(NSURLSession *)session
          dataTask:(NSURLSessionDataTask *)task
    didReceiveData:(NSData *)data {
  if (task != self.task)
    return;
  [self.buffer appendData:data];
  if (self.buffer.length > 1024 * 1024) {
    [self stop];
    return;
  }
  while (YES) {
    const uint8_t *bytes = self.buffer.bytes;
    NSUInteger pos = 0;
    while (pos < self.buffer.length && bytes[pos] != '\n')
      pos++;
    if (pos == self.buffer.length)
      break;
    NSData *lineData = [self.buffer subdataWithRange:NSMakeRange(0, pos)];
    [self.buffer replaceBytesInRange:NSMakeRange(0, pos + 1) withBytes:NULL length:0];
    NSString *line = [[NSString alloc] initWithData:lineData encoding:NSUTF8StringEncoding];
    if (!line)
      continue;
    if ([line hasSuffix:@"\r"])
      line = [line substringToIndex:line.length - 1];
    if (!line.length) {
      [self event];
      self.eventType = nil;
      self.eventId = nil;
      [self.eventLines removeAllObjects];
    } else if ([line hasPrefix:@"data:"])
      [self.eventLines
          addObject:[[line substringFromIndex:5]
                        stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceCharacterSet]];
    else if ([line hasPrefix:@"event:"])
      self.eventType = [[line substringFromIndex:6]
          stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceCharacterSet];
    else if ([line hasPrefix:@"id:"])
      self.eventId = [[line substringFromIndex:3]
          stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceCharacterSet];
  }
}
- (void)event {
  if (![self.eventType isEqual:@"notification"] || !self.eventLines.count)
    return;
  NSData *data =
      [[self.eventLines componentsJoinedByString:@"\n"] dataUsingEncoding:NSUTF8StringEncoding];
  NSDictionary *n = [NSJSONSerialization JSONObjectWithData:data options:0 error:nil];
  NSString *identity = [n[@"id"] isKindOfClass:NSString.class] ? n[@"id"] : nil;
  if (!identity.length)
    return;
  NSString *base = GBConnection.shared.serverURL;
  if (!base)
    return;
  NSMutableDictionary *cursors =
      [[NSUserDefaults.standardUserDefaults dictionaryForKey:@"GrokBotLocal.notificationCursor"]
          mutableCopy]
          ?: [NSMutableDictionary dictionary];
  cursors[base] = self.eventId ?: identity;
  [NSUserDefaults.standardUserDefaults setObject:cursors forKey:@"GrokBotLocal.notificationCursor"];
  GBReceiveLocalNotification(n);
}
- (void)URLSession:(NSURLSession *)session
                    task:(NSURLSessionTask *)task
    didCompleteWithError:(NSError *)error {
  if (task != self.task)
    return;
  self.task = nil;
  NSUInteger generation = self.generation;
  dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 3 * NSEC_PER_SEC), dispatch_get_main_queue(), ^{
    if (self.generation == generation)
      [self start];
  });
}
@end

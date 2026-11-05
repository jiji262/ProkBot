#import "GBDeepLinks.h"
#import "GBDiagnostics.h"
#import <objc/message.h>
#import <objc/runtime.h>

static IMP GBOriginalLinkURL;
static IMP GBOriginalInitialURL;
static IMP GBOriginalStartObserving;
static IMP GBOriginalStopObserving;
static BOOL GBObserving;
static BOOL GBHasBeenActive;
static NSURL *GBPendingNotificationURL;
static NSURL *GBInitialNotificationURL;

static void GBDeliverURL(NSURL *url) {
  GBDiagnosticsEvent(@"link.deliver", @{@"url":url.absoluteString ?: @""});
  Class linking = NSClassFromString(@"RCTLinkingManager");
  SEL selector = sel_registerName("application:openURL:options:");
  if ([linking respondsToSelector:selector]) {
    id application = ((id (*)(id, SEL))objc_msgSend)(
        NSClassFromString(@"UIApplication"), sel_registerName("sharedApplication"));
    ((BOOL (*)(id, SEL, id, id, id))objc_msgSend)(linking, selector, application, url, @{});
  }
}

NSURL *GBChatURL(NSString *agentId) {
  if (![agentId isKindOfClass:NSString.class] || !agentId.length || agentId.length > 128 ||
      [agentId rangeOfCharacterFromSet:
                   [[NSCharacterSet characterSetWithCharactersInString:
                       @"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_"]
                       invertedSet]].location != NSNotFound)
    return nil;
  // The original GrokBotLinks parser accepts app/v1/chat?id=, not chat/<id>.
  return [NSURL URLWithString:[@"grokbot://app/v1/chat?id=" stringByAppendingString:agentId]];
}

NSURL *GBNormalizeLocalURL(NSURL *url) {
  NSString *scheme = url.scheme.lowercaseString;
  if ([scheme isEqual:@"gblocal"] || [scheme isEqual:@"gblocal-ios"]) {
    NSURLComponents *components = [NSURLComponents componentsWithURL:url resolvingAgainstBaseURL:NO];
    components.scheme = [scheme isEqual:@"gblocal"] ? @"grokbot" : @"sand-mobile";
    return components.URL ?: url;
  }
  if (![url.scheme.lowercaseString isEqual:@"grokbot-local"] ||
      ![@[@"agent", @"chat"] containsObject:url.host.lowercaseString] ||
      url.user || url.password || url.port || url.query || url.fragment)
    return url;
  NSArray<NSString *> *parts = url.pathComponents;
  if (parts.count != 2 || ![parts[0] isEqual:@"/"])
    return url;
  return GBChatURL(parts[1]) ?: url;
}

static BOOL GBLinkURL(id self, SEL cmd, id application, NSURL *url, NSDictionary *options) {
  return ((BOOL (*)(id, SEL, id, id, id))GBOriginalLinkURL)(
      self, cmd, application, GBNormalizeLocalURL(url), options);
}

static void GBInitialURL(id self, SEL cmd, void (^resolve)(id), id reject) {
  void (^normalized)(id) = ^(id value) {
    @synchronized (NSClassFromString(@"RCTLinkingManager")) {
      if (GBInitialNotificationURL) {
        // The app has multiple initial-URL consumers, including its chat router
        // after account initialization. Match launchOptions' stable URL semantics.
        value = GBInitialNotificationURL.absoluteString;
      } else if (GBPendingNotificationURL) {
        value = GBPendingNotificationURL.absoluteString;
        GBPendingNotificationURL = nil;
      }
    }
    if ([value isKindOfClass:NSString.class])
      value = GBNormalizeLocalURL([NSURL URLWithString:value]).absoluteString ?: value;
    GBDiagnosticsEvent(@"link.initial", @{@"url":[value isKindOfClass:NSString.class] ? value : @""});
    resolve(value);
  };
  ((void (*)(id, SEL, id, id))GBOriginalInitialURL)(self, cmd, normalized, reject);
}

static void GBStartObserving(id self, SEL cmd) {
  ((void (*)(id, SEL))GBOriginalStartObserving)(self, cmd);
  NSURL *pending;
  @synchronized (NSClassFromString(@"RCTLinkingManager")) {
    GBObserving = YES;
    pending = GBPendingNotificationURL;
    GBPendingNotificationURL = nil;
  }
  if (pending) GBDeliverURL(pending);
  GBDiagnosticsEvent(@"link.observing", @{@"pending":pending ? @YES : @NO});
}

static void GBStopObserving(id self, SEL cmd) {
  GBDiagnosticsEvent(@"link.stop", @{});
  @synchronized (NSClassFromString(@"RCTLinkingManager")) {
    GBObserving = NO;
    if (GBHasBeenActive) GBInitialNotificationURL = nil;
  }
  ((void (*)(id, SEL))GBOriginalStopObserving)(self, cmd);
}

void GBInstallDeepLinks(void) {
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    // Use notification names so the routing unit is also testable with Foundation.
    NSNotificationCenter *center = NSNotificationCenter.defaultCenter;
    [center addObserverForName:@"UIApplicationDidBecomeActiveNotification" object:nil queue:nil usingBlock:^(NSNotification *n) {
      @synchronized (NSClassFromString(@"RCTLinkingManager")) { GBHasBeenActive = YES; }
      GBDiagnosticsEvent(@"application.active", @{});
    }];
    [center addObserverForName:@"UIApplicationDidEnterBackgroundNotification" object:nil queue:nil usingBlock:^(NSNotification *n) {
      @synchronized (NSClassFromString(@"RCTLinkingManager")) { GBInitialNotificationURL = nil; }
      GBDiagnosticsEvent(@"application.background", @{});
    }];
  });
  Class linking = NSClassFromString(@"RCTLinkingManager");
  if (!GBOriginalLinkURL) {
    Method method = class_getClassMethod(linking, sel_registerName("application:openURL:options:"));
    if (method) GBOriginalLinkURL = method_setImplementation(method, (IMP)GBLinkURL);
  }
  if (!GBOriginalInitialURL) {
    Method method = class_getInstanceMethod(linking, sel_registerName("getInitialURL:reject:"));
    if (method) GBOriginalInitialURL = method_setImplementation(method, (IMP)GBInitialURL);
  }
  if (!GBOriginalStartObserving) {
    Method method = class_getInstanceMethod(linking, sel_registerName("startObserving"));
    if (method) GBOriginalStartObserving = method_setImplementation(method, (IMP)GBStartObserving);
  }
  if (!GBOriginalStopObserving) {
    Method method = class_getInstanceMethod(linking, sel_registerName("stopObserving"));
    if (method) GBOriginalStopObserving = method_setImplementation(method, (IMP)GBStopObserving);
  }
}

void GBOpenAgent(NSString *agentId) {
  NSURL *url = GBChatURL(agentId);
  if (!url) return;
  GBDiagnosticsEvent(@"notification.open", @{@"agentId":agentId, @"observing":GBObserving ? @YES : @NO, @"hasBeenActive":GBHasBeenActive ? @YES : @NO});
  @synchronized (NSClassFromString(@"RCTLinkingManager")) {
    if (!GBHasBeenActive) {
      GBInitialNotificationURL = url;
      if (!GBObserving) return;
    }
    if (!GBObserving) {
      GBPendingNotificationURL = url;
      return;
    }
  }
  GBDeliverURL(url);
}

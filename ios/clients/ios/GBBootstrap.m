#import "GBComputers.h"
#import "GBConnection.h"
#import "GBAppIntents.h"
#import "GBLibrary.h"
#import "GBNotifications.h"
#import "GBProfile.h"
#import "GBPush.h"
#import "GBConnectors.h"
#import "GBDeepLinks.h"
#import "GBDiagnostics.h"
#import "GBLocalize.h"
#import "GBUsage.h"
#import "GBNetwork.h"
#import <dlfcn.h>
#import <objc/message.h>
#import <objc/runtime.h>

static IMP GBOriginalLoad;
static __weak id GBHost;
static BOOL GBLoadedPairedBundle;
static UIWindow *GBWindow(void) {
  for (UIScene *scene in UIApplication.sharedApplication.connectedScenes)
    if ([scene isKindOfClass:UIWindowScene.class])
      for (UIWindow *window in ((UIWindowScene *)scene).windows)
        if (window.isKeyWindow)
          return window;
  return nil;
}
static id GBIvar(id object, const char *name) {
  if (!object)
    return nil;
  Ivar ivar = class_getInstanceVariable(object_getClass(object), name);
  return ivar ? object_getIvar(object, ivar) : nil;
}
static id GBFindHost(void) {
  id delegate = UIApplication.sharedApplication.delegate;
  return GBIvar(GBIvar(GBIvar(delegate, "reactNativeFactory"), "_rootViewFactory"), "_reactHost");
}
static void GBLoad(id self, SEL cmd, NSURL *url, id progress, id completion) {
  GBHost = self;
  NSURL *patched = GBConnection.shared.gatewayBundleURL;
  GBLoadedPairedBundle = patched != nil;
  GBDiagnosticsRecordBundle(url, patched ?: url);
  ((void (*)(id, SEL, NSURL *, id, id))GBOriginalLoad)(self, cmd, patched ?: url, progress,
                                                       completion);
}
void GBReloadReactHost(void) {
  dispatch_async(dispatch_get_main_queue(), ^{
    GBDiagnosticsEvent(@"react.reload", @{});
    id host = GBHost ?: GBFindHost();
    SEL reload = sel_registerName("didReceiveReloadCommand");
    if ([host respondsToSelector:reload])
      ((void (*)(id, SEL))objc_msgSend)(host, reload);
  });
}
@interface GBInterface : NSObject
+ (void)showConnection;
+ (void)refresh;
@end
@implementation GBInterface
+ (void)showLibrary {
  GBShowLibrary();
}
+ (void)showComputers {
  GBShowComputers();
}
+ (void)showConnection {
  [GBConnection.shared show];
}
+ (void)replaceEntry:(UIView *)view {
  if ((view.tag >= 731989 && view.tag <= 731999))
    return;
  NSString *label = view.accessibilityLabel;
  if ([view isKindOfClass:UILabel.class])
    label = ((UILabel *)view).text;
  if ([view isKindOfClass:UIButton.class])
    label = [((UIButton *)view) titleForState:UIControlStateNormal];
  GBObserveAppLanguage(label);
  NSSet *labels = [NSSet setWithArray:@[
    @"Log in", @"Login", @"Sign in", @"登录", @"登入", @"登陆", @"登录或注册", @"Log in or sign up"
  ]];
  for (UIView *child in [view.subviews copy]) {
    if (child.tag == 731989 && ![@[@"用量", @"Usage"] containsObject:label])
      [child removeFromSuperview];
    if (child.tag == 731991 && ![labels containsObject:label] && ![@[@"调试", @"Debug", @"link"] containsObject:label])
      [child removeFromSuperview];
    if (child.tag == 731992 && ![@[@"资料库", @"Library"] containsObject:label])
      [child removeFromSuperview];
    if (child.tag == 731993 && ![label isEqual:@"dev-gateway@localhost"] &&
        ![label isEqual:@"dev-gateway@localhost avatar"]) {
      GBResetProfileView(view);
      [child removeFromSuperview];
    }
    if (child.tag == 731999 && ![@[@"Bot 电脑", @"Bot Computer"] containsObject:label])
      [child removeFromSuperview];
  }
  if (GBReplaceProfileView(view))
    return;
  if (GBReplacePushView(view))
    return;
  if ([@[@"Bot 电脑", @"Bot Computer"] containsObject:label] && view.bounds.size.width > 300 &&
      view.bounds.size.height >= 44) {
    if (![view viewWithTag:731999]) {
      UIButton *button = [UIButton buttonWithType:UIButtonTypeCustom];
      button.tag = 731999;
      button.frame = view.bounds;
      button.autoresizingMask = UIViewAutoresizingFlexibleWidth | UIViewAutoresizingFlexibleHeight;
      button.accessibilityLabel = GBL(@"Bot 电脑", @"Bot Computer");
      [button addTarget:self
                    action:@selector(showComputers)
          forControlEvents:UIControlEventTouchUpInside];
      view.userInteractionEnabled = YES;
      [view addSubview:button];
    }
    return;
  }
  if (([@[@"调试", @"Debug", @"link", @"连接 Host", @"Host Connection"] containsObject:label]) && GBConnection.shared.deviceToken.length && view.bounds.size.width <= 88) {
    // Keep the original toolbar and link icon; only route the original touch.
    view.accessibilityLabel = GBL(@"连接 Host", @"Host Connection");
    view.accessibilityIdentifier = @"grokbot.host.settings";
    return;
  }
  if ([@[@"资料库", @"Library"] containsObject:label] && GBConnection.shared.deviceToken.length &&
      view.bounds.size.width > 20) {
    if (![view viewWithTag:731992]) {
      UIButton *button = [UIButton buttonWithType:UIButtonTypeSystem];
      button.tag = 731992;
      button.frame = view.bounds;
      button.autoresizingMask = UIViewAutoresizingFlexibleWidth | UIViewAutoresizingFlexibleHeight;
      button.backgroundColor = view.backgroundColor ?: UIColor.clearColor;
      [button setTitle:GBL(@"资料库", @"Library") forState:UIControlStateNormal];
      button.titleLabel.font = [UIFont systemFontOfSize:14];
      [button setTitleColor:UIColor.secondaryLabelColor forState:UIControlStateNormal];
      [button addTarget:self
                    action:@selector(showLibrary)
          forControlEvents:UIControlEventTouchUpInside];
      view.userInteractionEnabled = YES;
      [view addSubview:button];
    }
    return;
  }
  GBReplaceUsageView(view);
}
+ (void)replaceLogin:(UIView *)view {
  [self replaceEntry:view];
  if (view.tag >= 731989 && view.tag <= 731999) return;
  for (UIView *child in view.subviews) [self replaceLogin:child];
}
+ (void)refresh {
  UIWindow *window = GBWindow();
  if (!window)
    return;
  [self replaceLogin:window];
}

@end
static IMP GBOriginalTask;
static IMP GBOriginalSimpleTask;
static IMP GBOriginalTouches;
static IMP GBOriginalRecycle;
static IMP GBOriginalLayout;
static void GBLayout(id self, SEL selector) {
  ((void (*)(id, SEL))GBOriginalLayout)(self, selector);
  // Fabric has populated labels and bounds at this point, before the first
  // frame is displayed. Update the affected view here, without polling the
  // entire window while the interface is idle.
  [GBInterface replaceEntry:self];
}
static void GBRecycle(id self, SEL selector) {
  GBResetProfileView(self);
  GBResetPushView(self);
  for (UIView *child in [[self subviews] copy])
    if (child.tag >= 731989 && child.tag <= 731999)
      [child removeFromSuperview];
  ((void (*)(id, SEL))GBOriginalRecycle)(self, selector);
}
static void GBTouches(id self, SEL selector, NSSet<UITouch *> *touches, UIEvent *event) {
  for (UITouch *touch in touches)
    for (UIView *v = touch.view; v; v = v.superview)
      if ([@[@"连接服务端", @"Connect to Host"] containsObject:v.accessibilityLabel] || [v.accessibilityIdentifier isEqual:@"grokbot.host.settings"] || ([v.accessibilityLabel isEqual:@"link"] && GBConnection.shared.deviceToken.length)) {
        [GBConnection.shared show];
        return;
      }
  // Fabric handles ancestor touches even when a native button receives them.
  // Exclude only plugin controls to prevent both local and cloud actions firing.
  for (UITouch *touch in touches)
    for (UIView *v = touch.view; v; v = v.superview)
      if (v.tag >= 731989 && v.tag <= 731999)
        return;
  ((void (*)(id, SEL, id, id))GBOriginalTouches)(self, selector, touches, event);
}
static id GBSimpleTask(id self, SEL selector, NSURLRequest *request) {
  BOOL networkReady = GBNetworkEnsureReadyForURL(request.URL);
  GBDiagnosticsEvent(@"network.request", @{@"host":request.URL.host ?: @"", @"path":request.URL.path ?: @""});
  GBObserveRequest(request);
  id task = ((id (*)(id, SEL, id))GBOriginalSimpleTask)(self, selector, request);
  if (!networkReady) [task cancel];
  GBDiagnosticsObserveTask(task);
  return task;
}
static id GBTask(id self, SEL selector, NSURLRequest *request, id completion) {
  BOOL networkReady = GBNetworkEnsureReadyForURL(request.URL);
  GBDiagnosticsEvent(@"network.request", @{@"host":request.URL.host ?: @"", @"path":request.URL.path ?: @""});
  GBObserveRequest(request);
  if (getenv("GROKBOT_VALIDATE_CAPTURE") && completion) {
    void (^original)(NSData *, NSURLResponse *, NSError *) = completion;
    completion = ^(NSData *data, NSURLResponse *response, NSError *error) {
      GBDiagnosticsEvent(@"network.complete", @{@"path":request.URL.path ?: @"", @"status":@(((NSHTTPURLResponse *)response).statusCode), @"error":@(error.code)});
      original(data, response, error);
    };
  }
  id task = ((id (*)(id, SEL, id, id))GBOriginalTask)(self, selector, request, completion);
  if (!networkReady) [task cancel];
  return task;
}
static void GBInstall(void) {
  GBInstallDeepLinks();
  if (!GBOriginalLayout) {
    Class cls = NSClassFromString(@"RCTViewComponentView");
    Method method = class_getInstanceMethod(cls, @selector(layoutSubviews));
    if (method) {
      GBOriginalLayout = method_getImplementation(method);
      class_replaceMethod(cls, @selector(layoutSubviews), (IMP)GBLayout, method_getTypeEncoding(method));
    }
  }
  if (!GBOriginalRecycle) {
    Method method = class_getInstanceMethod(NSClassFromString(@"RCTViewComponentView"),
                                            sel_registerName("prepareForRecycle"));
    if (method)
      GBOriginalRecycle = method_setImplementation(method, (IMP)GBRecycle);
  }
  if (!GBOriginalTouches) {
    Method method = class_getInstanceMethod(NSClassFromString(@"RCTSurfaceTouchHandler"),
                                            @selector(touchesBegan:withEvent:));
    if (method)
      GBOriginalTouches = method_setImplementation(method, (IMP)GBTouches);
  }
  if (!GBOriginalSimpleTask) {
    Method method =
        class_getInstanceMethod(NSURLSession.class, sel_registerName("dataTaskWithRequest:"));
    if (method)
      GBOriginalSimpleTask = method_setImplementation(method, (IMP)GBSimpleTask);
  }
  if (!GBOriginalTask) {
    Method method = class_getInstanceMethod(
        NSURLSession.class, sel_registerName("dataTaskWithRequest:completionHandler:"));
    if (method)
      GBOriginalTask = method_setImplementation(method, (IMP)GBTask);
  }
  if (!GBOriginalLoad) {
    Method method = class_getInstanceMethod(
        NSClassFromString(@"RCTHost"), sel_registerName("loadBundleAtURL:onProgress:onComplete:"));
    if (method)
      GBOriginalLoad = method_setImplementation(method, (IMP)GBLoad);
  }
}
__attribute__((constructor)) static void GBInitialize(void) {
  @autoreleasepool {
    GBDiagnosticsEvent(@"bootstrap.begin", @{});
    Dl_info location = {0};
    dladdr((const void *)&GBInitialize, &location);
    NSString *libraryPath =
        location.dli_fname ? [NSString stringWithUTF8String:location.dli_fname] : nil;
    if (!libraryPath.length)
      return;
    GBConnection.shared.resourcesURL =
        [[NSURL fileURLWithPath:libraryPath.stringByDeletingLastPathComponent]
            URLByAppendingPathComponent:@"GrokBotLocal.bundle"
                            isDirectory:YES];
    NSError *error = nil;
    BOOL restored = [GBConnection.shared restore:&error];
    GBDiagnosticsEvent(@"connection.restore", @{@"restored":restored ? @YES : @NO});
    GBInstallConnectorTransport();
    GBInstall();
    // Restore before the app creates its first RCTHost. A delayed unconditional
    // reload discards the navigation established by a cold notification click.
    dispatch_async(dispatch_get_main_queue(), ^{
      GBNetworkEnsureReadyForURL([NSURL URLWithString:GBConnection.shared.serverURL]);
      GBConnection.shared.didConnect = ^{
        GBSyncAppIntentCredentials();
        [[GBNotifications shared] start];
        GBPushSetForeground(UIApplication.sharedApplication.applicationState == UIApplicationStateActive);
        GBRefreshProfile();
        dispatch_after(dispatch_time(DISPATCH_TIME_NOW, NSEC_PER_SEC), dispatch_get_main_queue(), ^{ GBPushRefresh(); });
      };
      GBConnection.shared.didDisconnect = ^{
        [[GBNotifications shared] stop];
      };
      NSNotificationCenter *center = NSNotificationCenter.defaultCenter;
      [center addObserverForName:UIApplicationDidBecomeActiveNotification
                          object:nil
                           queue:NSOperationQueue.mainQueue
                      usingBlock:^(NSNotification *n) {
                        GBInstall();
                        GBNetworkEnsureReadyForURL([NSURL URLWithString:GBConnection.shared.serverURL]);
                        GBSyncAppIntentCredentials();
                        [GBInterface refresh];
                        [[GBNotifications shared] start];
                        GBPushSetForeground(YES);
                        GBRefreshProfile();
                        GBPushRefresh();
                      }];
      [center addObserverForName:UIApplicationDidEnterBackgroundNotification
                          object:nil
                           queue:NSOperationQueue.mainQueue
                      usingBlock:^(NSNotification *n) {
                        [[GBNotifications shared] stop];
                        GBPushSetForeground(NO);
                      }];
      for (NSString *name in @[@"GrokBotProfileChanged", @"GrokBotPushStateChanged"])
        [center addObserverForName:name object:nil queue:NSOperationQueue.mainQueue usingBlock:^(NSNotification *n) { [GBInterface refresh]; }];
      [NSTimer scheduledTimerWithTimeInterval:25 repeats:YES block:^(NSTimer *timer) {
        if (UIApplication.sharedApplication.applicationState == UIApplicationStateActive) GBPushSetForeground(YES);
      }];
      // Inspect cached transport health only while active. This also recovers a
      // stale peer when the original UI is waiting without making new requests.
      [NSTimer scheduledTimerWithTimeInterval:5 repeats:YES block:^(NSTimer *timer) {
        if (UIApplication.sharedApplication.applicationState == UIApplicationStateActive)
          GBNetworkEnsureReadyForURL([NSURL URLWithString:GBConnection.shared.serverURL]);
      }];
      dispatch_after(dispatch_time(DISPATCH_TIME_NOW, NSEC_PER_SEC), dispatch_get_main_queue(), ^{
        [GBInterface refresh];
        if (restored) {
          if (GBHost && !GBLoadedPairedBundle) GBReloadReactHost();
          [[GBNotifications shared] start];
          GBRefreshProfile();
          GBPushRefresh();
        }
      });
    });
  }
}

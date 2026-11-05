#import "GBLocalize.h"
#import "GBPush.h"
#import "GBConnection.h"
#import "GBHTTP.h"
#import "GBDiagnostics.h"
#import <Security/Security.h>
#import <UserNotifications/UserNotifications.h>
#import <dlfcn.h>
#import <objc/runtime.h>

static NSString *GBAPNsToken;
static NSString *GBRegistrationError;
static BOOL GBAuthorizing;
static BOOL GBAuthorizationAttempted;
static BOOL GBPromptVisible;
static IMP GBOriginalRegistered;
static IMP GBOriginalFailed;
static Class GBInstalledDelegate;
static NSDictionary *GBDevicePushState;
static NSString *GBDevicePushStateIdentity;
static char GBOriginalSwitchTargets;
static NSString *GBPushStateKey(void) {
  return [@"GrokBotLocal.pushState." stringByAppendingString:
    [NSUserDefaults.standardUserDefaults stringForKey:@"GrokBotLocal.deviceId"] ?: @"unpaired"];
}
static void GBPushDiagnostic(NSString *event, NSDictionary *values) {
  if (!getenv("GROKBOT_VALIDATE_CAPTURE")) return;
  NSURL *dir = [[NSFileManager.defaultManager URLsForDirectory:NSDocumentDirectory inDomains:NSUserDomainMask].firstObject URLByAppendingPathComponent:@"HostValidation"];
  [NSFileManager.defaultManager createDirectoryAtURL:dir withIntermediateDirectories:YES attributes:nil error:nil];
  NSMutableDictionary *report = [values mutableCopy]; report[@"event"] = event;
  [[NSJSONSerialization dataWithJSONObject:report options:NSJSONWritingPrettyPrinted error:nil]
      writeToURL:[dir URLByAppendingPathComponent:[@"push-" stringByAppendingFormat:@"%@.json",event]] atomically:YES];
}
static NSString *GBAuthName(UNAuthorizationStatus value) {
  switch (value) {
  case UNAuthorizationStatusDenied: return @"denied";
  case UNAuthorizationStatusAuthorized: return @"authorized";
  case UNAuthorizationStatusProvisional: return @"provisional";
  case UNAuthorizationStatusEphemeral: return @"ephemeral";
  default: return @"notDetermined";
  }
}
static NSString *GBReadPushEnvironment(void) {
  // Query the running process's actual code-signing entitlement, not its profile
  // and not the separate user-notification authorization setting.
  typedef CFTypeRef (*Create)(CFAllocatorRef);
  typedef CFTypeRef (*Copy)(CFTypeRef, CFStringRef, CFErrorRef *);
  Create create = (Create)dlsym(RTLD_DEFAULT, "SecTaskCreateFromSelf");
  Copy copy = (Copy)dlsym(RTLD_DEFAULT, "SecTaskCopyValueForEntitlement");
  if (!create || !copy) return nil;
  CFTypeRef task = create(kCFAllocatorDefault);
  if (!task) return nil;
  id value = CFBridgingRelease(copy(task, CFSTR("aps-environment"), NULL));
  CFRelease(task);
  return [value isEqual:@"development"] || [value isEqual:@"production"] ? value : nil;
}
NSString *GBPushEnvironment(void) {
  static NSString *environment;
  static dispatch_once_t once;
  dispatch_once(&once, ^{ environment = GBReadPushEnvironment(); });
  return environment;
}
static UIViewController *GBPushTop(void) {
  UIViewController *top;
  for (UIScene *s in UIApplication.sharedApplication.connectedScenes)
    if ([s isKindOfClass:UIWindowScene.class])
      for (UIWindow *w in ((UIWindowScene *)s).windows)
        if (w.isKeyWindow) top = w.rootViewController;
  while (top.presentedViewController) top = top.presentedViewController;
  return top;
}
static void GBDeviceRequest(NSString *method, NSDictionary *body,
                            void (^done)(NSDictionary *, NSError *)) {
  NSString *base = GBConnection.shared.serverURL, *token = GBConnection.shared.deviceToken;
  if (!base.length || !token.length) return;
  NSMutableURLRequest *r = [NSMutableURLRequest requestWithURL:
    [NSURL URLWithString:[base stringByAppendingString:@"/local/device"]]];
  r.HTTPMethod = method; r.timeoutInterval = 15;
  [r setValue:[@"Bearer " stringByAppendingString:token] forHTTPHeaderField:@"Authorization"];
  if (body) {
    r.HTTPBody = [NSJSONSerialization dataWithJSONObject:body options:0 error:nil];
    [r setValue:@"application/json" forHTTPHeaderField:@"Content-Type"];
  }
  [[GBHTTPSession() dataTaskWithRequest:r completionHandler:^(NSData *data, NSURLResponse *response, NSError *error) {
    NSDictionary *value = data ? [NSJSONSerialization JSONObjectWithData:data options:0 error:nil] : nil;
    NSInteger status = ((NSHTTPURLResponse *)response).statusCode;
    if (!error && (status < 200 || status >= 300 || ![value isKindOfClass:NSDictionary.class]))
      error = [NSError errorWithDomain:@"GrokBotDevice" code:status userInfo:nil];
    GBPushDiagnostic(@"request", @{@"method":method,@"status":@(status),@"errorDomain":error.domain ?: @"",@"errorCode":@(error.code),@"responseError":[value[@"error"] isKindOfClass:NSString.class] ? value[@"error"] : @""});
    dispatch_async(dispatch_get_main_queue(), ^{
      if (![base isEqual:GBConnection.shared.serverURL] || ![token isEqual:GBConnection.shared.deviceToken]) return;
      if (!error && [value[@"push"] isKindOfClass:NSDictionary.class]) {
        // Persist only display state, never push tokens, URLs, or JSON nulls.
        GBDevicePushState = @{@"provider":value[@"push"][@"provider"] ?: @"none",
                              @"configured":[value[@"push"][@"configured"] boolValue] ? @YES : @NO,
                              @"enabled":[value[@"push"][@"enabled"] boolValue] ? @YES : @NO,
                              @"authorization":value[@"push"][@"authorization"] ?: @"notDetermined"};
        GBDevicePushStateIdentity = GBPushStateKey();
        [NSUserDefaults.standardUserDefaults setObject:GBDevicePushState forKey:GBPushStateKey()];
        [NSNotificationCenter.defaultCenter postNotificationName:@"GrokBotPushStateChanged" object:nil];
      }
      if (done) done(value, error);
    });
  }] resume];
}
static void GBReportDevice(UNNotificationSettings *settings) {
  NSString *environment = GBPushEnvironment();
  GBPushDiagnostic(@"registration", @{@"environment":environment ?: (id)NSNull.null,@"authorization":GBAuthName(settings.authorizationStatus),@"tokenPresent":@(GBAPNsToken.length > 0),@"registrationError":GBRegistrationError ?: @""});
  NSMutableDictionary *body = [@{
    @"name": UIDevice.currentDevice.name,
    @"kind": UIDevice.currentDevice.userInterfaceIdiom == UIUserInterfaceIdiomPad ? @"ipad" : @"iphone",
    @"bundleId": NSBundle.mainBundle.bundleIdentifier,
    @"appVersion": [NSBundle.mainBundle objectForInfoDictionaryKey:@"CFBundleShortVersionString"] ?: @"",
    // Objective-C comparison expressions box as NSNumber(int), which JSON
    // encodes as 0/1. The Host correctly requires a JSON boolean here.
    @"apnsCapable": environment ? @YES : @NO,
    @"apnsEnvironment": environment ?: NSNull.null,
    @"authorization": GBAuthName(settings.authorizationStatus)
  } mutableCopy];
  if (environment && GBAPNsToken.length)
    body[@"push"] = @{ @"provider": @"apns", @"token": GBAPNsToken, @"registrationError": NSNull.null };
  else if (GBRegistrationError)
    body[@"push"] = @{ @"registrationError": GBRegistrationError };
  else if (!environment)
    body[@"push"] = @{ @"registrationError": NSNull.null };
  GBDeviceRequest(@"PUT", body, nil);
}
void GBPushSetForeground(BOOL foreground) {
  if (!GBConnection.shared.deviceToken.length) return;
  __block UIBackgroundTaskIdentifier task = UIBackgroundTaskInvalid;
  if (!foreground)
    task = [UIApplication.sharedApplication beginBackgroundTaskWithName:@"Host notification state" expirationHandler:^{
      if (task != UIBackgroundTaskInvalid) {
        [UIApplication.sharedApplication endBackgroundTask:task]; task = UIBackgroundTaskInvalid;
      }
    }];
  GBDeviceRequest(@"PUT", @{@"foreground":foreground ? @YES : @NO}, ^(NSDictionary *value, NSError *error) {
    GBDiagnosticsEvent(@"presence.report", @{@"foreground":foreground ? @YES : @NO, @"success":error ? @NO : @YES});
    if (task != UIBackgroundTaskInvalid) {
      [UIApplication.sharedApplication endBackgroundTask:task]; task = UIBackgroundTaskInvalid;
    }
  });
}
static BOOL GBClaimNotification(NSString *identity) {
  NSString *base = GBConnection.shared.serverURL;
  if (!base.length || !identity.length) return NO;
  NSMutableDictionary *all = [[NSUserDefaults.standardUserDefaults dictionaryForKey:@"GrokBotLocal.notificationSeen"] mutableCopy] ?: [NSMutableDictionary new];
  NSMutableArray *seen = [all[base] mutableCopy] ?: [NSMutableArray new];
  if ([seen containsObject:identity]) return NO;
  [seen addObject:identity];
  while (seen.count > 256) [seen removeObjectAtIndex:0];
  all[base] = seen;
  [NSUserDefaults.standardUserDefaults setObject:all forKey:@"GrokBotLocal.notificationSeen"];
  return YES;
}
void GBReceiveLocalNotification(NSDictionary *n) {
  dispatch_async(dispatch_get_main_queue(), ^{
    NSString *identity = n[@"notificationId"] ?: n[@"id"];
    if (![identity isKindOfClass:NSString.class] || !GBClaimNotification(identity)) return;
    // The original PushPayload.foregroundBehavior suppresses task-completion
    // banners. Conversation state continues through the existing Gateway stream.
    // Keep receipts/deduplication without adding a separate completion UI.
    GBDiagnosticsEvent(@"notification.foregroundReceipt", @{ @"agentId": n[@"agentId"] ?: @"" });
  });
}
@interface GBPushDelegate : NSObject <UNUserNotificationCenterDelegate>
@property(nonatomic, weak) id<UNUserNotificationCenterDelegate> original;
@end
@implementation GBPushDelegate
- (BOOL)respondsToSelector:(SEL)selector {
  return [super respondsToSelector:selector] || [self.original respondsToSelector:selector];
}
- (id)forwardingTargetForSelector:(SEL)selector { return self.original; }
- (void)userNotificationCenter:(UNUserNotificationCenter *)center willPresentNotification:(UNNotification *)n
        withCompletionHandler:(void (^)(UNNotificationPresentationOptions))done {
  NSDictionary *payload = n.request.content.userInfo;
  if ([payload[@"notificationId"] isKindOfClass:NSString.class]) {
    GBDiagnosticsEvent(@"notification.foreground", @{@"agentId":payload[@"agentId"] ?: @""});
    GBReceiveLocalNotification(payload); done(UNNotificationPresentationOptionNone); return;
  }
  if ([self.original respondsToSelector:_cmd])
    [self.original userNotificationCenter:center willPresentNotification:n withCompletionHandler:done];
  else done(UNNotificationPresentationOptionNone);
}
- (void)userNotificationCenter:(UNUserNotificationCenter *)center didReceiveNotificationResponse:(UNNotificationResponse *)response
        withCompletionHandler:(void (^)(void))done {
  NSDictionary *p = response.notification.request.content.userInfo;
  if ([p[@"notificationId"] isKindOfClass:NSString.class]) {
    GBDiagnosticsEvent(@"notification.response", @{@"agentId":p[@"agentId"] ?: @"", @"action":response.actionIdentifier ?: @""});
    GBClaimNotification(p[@"notificationId"]);
    GBOpenAgent(p[@"agentId"]); done(); return;
  }
  if ([self.original respondsToSelector:_cmd])
    [self.original userNotificationCenter:center didReceiveNotificationResponse:response withCompletionHandler:done];
  else done();
}
@end
static GBPushDelegate *GBNotificationDelegate;
static IMP GBOriginalSetNotificationDelegate;
static void GBSetNotificationDelegate(id self, SEL cmd, id<UNUserNotificationCenterDelegate> delegate) {
  if (!GBNotificationDelegate) GBNotificationDelegate = [GBPushDelegate new];
  if (delegate != GBNotificationDelegate) GBNotificationDelegate.original = delegate;
  ((void (*)(id,SEL,id))GBOriginalSetNotificationDelegate)(self,cmd,GBNotificationDelegate);
}
__attribute__((constructor)) static void GBObserveNotificationDelegate(void) {
  // iOS may deliver a cold-start response before didBecomeActive/registration.
  // Wrap the first delegate assignment, while preserving unrelated notifications.
  Method method = class_getInstanceMethod(UNUserNotificationCenter.class, @selector(setDelegate:));
  if (method) GBOriginalSetNotificationDelegate = method_setImplementation(method,(IMP)GBSetNotificationDelegate);
}
static void GBRegistered(id self, SEL cmd, UIApplication *app, NSData *token) {
  if (!GBConnection.shared.deviceToken.length) {
    if (GBOriginalRegistered) ((void (*)(id,SEL,id,id))GBOriginalRegistered)(self,cmd,app,token);
    return;
  }
  const unsigned char *bytes = token.bytes;
  NSMutableString *value = [NSMutableString stringWithCapacity:token.length * 2];
  for (NSUInteger i=0; i<token.length; i++) [value appendFormat:@"%02x",bytes[i]];
  GBAPNsToken = value; GBRegistrationError = nil;
  [UNUserNotificationCenter.currentNotificationCenter getNotificationSettingsWithCompletionHandler:^(UNNotificationSettings *s) { GBReportDevice(s); }];
}
static void GBFailed(id self, SEL cmd, UIApplication *app, NSError *error) {
  if (!GBConnection.shared.deviceToken.length) {
    if (GBOriginalFailed) ((void (*)(id,SEL,id,id))GBOriginalFailed)(self,cmd,app,error);
    return;
  }
  // The original app can request APNs even in a wildcard-signed Bark build.
  // That expected missing-entitlement error is unrelated to Bark delivery.
  if (!GBPushEnvironment()) { GBRegistrationError = nil; return; }
  GBRegistrationError = [NSString stringWithFormat:@"%@ (%ld)",error.domain,(long)error.code];
  [UNUserNotificationCenter.currentNotificationCenter getNotificationSettingsWithCompletionHandler:^(UNNotificationSettings *s) { GBReportDevice(s); }];
}
static IMP GBHook(Class cls, SEL selector, IMP replacement) {
  Method method = class_getInstanceMethod(cls, selector);
  IMP original = method ? method_getImplementation(method) : NULL;
  const char *types = method ? method_getTypeEncoding(method) : "v@:@@";
  class_replaceMethod(cls, selector, replacement, types); return original;
}
static void GBInstallPushDelegate(void) {
  Class cls = object_getClass(UIApplication.sharedApplication.delegate);
  if (cls && GBInstalledDelegate != cls) {
    GBOriginalRegistered = GBHook(cls, @selector(application:didRegisterForRemoteNotificationsWithDeviceToken:), (IMP)GBRegistered);
    GBOriginalFailed = GBHook(cls, @selector(application:didFailToRegisterForRemoteNotificationsWithError:), (IMP)GBFailed);
    GBInstalledDelegate = cls;
  }
  UNUserNotificationCenter *center = UNUserNotificationCenter.currentNotificationCenter;
  if (!GBNotificationDelegate) GBNotificationDelegate = [GBPushDelegate new];
  if (center.delegate != GBNotificationDelegate) {
    GBNotificationDelegate.original = center.delegate; center.delegate = GBNotificationDelegate;
  }
}
static NSString *GBPromptKey(void) {
  return [@"GrokBotLocal.barkPrompt." stringByAppendingString:
    [NSUserDefaults.standardUserDefaults stringForKey:@"GrokBotLocal.deviceId"] ?: @"unpaired"];
}
static void GBShowBark(void) {
  if (GBPromptVisible || !GBConnection.shared.deviceToken.length) return;
  UIViewController *top = GBPushTop(); if (!top) return;
  GBPromptVisible = YES;
  UIAlertController *alert = [UIAlertController alertControllerWithTitle:GBL(@"接收通知", @"Notifications")
    message:GBL(@"粘贴 Bark 推送链接", @"Paste your Bark notification URL")
    preferredStyle:UIAlertControllerStyleAlert];
  [alert addTextFieldWithConfigurationHandler:^(UITextField *field) {
    field.placeholder = @"https://api.day.app/…"; field.keyboardType = UIKeyboardTypeURL;
    field.autocapitalizationType = UITextAutocapitalizationTypeNone;
    field.autocorrectionType = UITextAutocorrectionTypeNo; field.secureTextEntry = YES;
  }];
  [alert addAction:[UIAlertAction actionWithTitle:GBL(@"稍后", @"Not now") style:UIAlertActionStyleCancel handler:^(UIAlertAction *a) {
    GBPromptVisible = NO; [NSUserDefaults.standardUserDefaults setBool:YES forKey:GBPromptKey()];
  }]];
  [alert addAction:[UIAlertAction actionWithTitle:GBL(@"保存", @"Save") style:UIAlertActionStyleDefault handler:^(UIAlertAction *a) {
    GBPromptVisible = NO;
    NSString *input = alert.textFields.firstObject.text;
    GBDeviceRequest(@"PUT", @{ @"push": @{ @"provider": @"bark", @"barkUrl": input ?: @"" } }, ^(NSDictionary *value, NSError *error) {
      if (!error) { [NSUserDefaults.standardUserDefaults setBool:YES forKey:GBPromptKey()]; return; }
      UIAlertController *failed = [UIAlertController alertControllerWithTitle:GBL(@"未能保存", @"Could not save")
        message:GBL(@"请检查 Bark 链接和服务端连接。", @"Check the Bark URL and Host connection.") preferredStyle:UIAlertControllerStyleAlert];
      [failed addAction:[UIAlertAction actionWithTitle:GBL(@"重试", @"Retry") style:UIAlertActionStyleDefault handler:^(UIAlertAction *a) { GBShowBark(); }]];
      [failed addAction:[UIAlertAction actionWithTitle:GBL(@"稍后", @"Not now") style:UIAlertActionStyleCancel handler:nil]];
      [GBPushTop() presentViewController:failed animated:YES completion:nil];
    });
  }]];
  [top presentViewController:alert animated:YES completion:nil];
}
void GBPushShowSettings(void) {
  if (!GBPushEnvironment()) { GBShowBark(); return; }
  [UIApplication.sharedApplication openURL:[NSURL URLWithString:UIApplicationOpenSettingsURLString] options:@{} completionHandler:nil];
}
@interface GBPushEntry : UIButton
@property(nonatomic, weak) UISwitch *originalSwitch;
@property(nonatomic, strong) UILabel *stateLabel;
@property(nonatomic, strong) UIImageView *chevron;
@end
@implementation GBPushEntry
- (void)open { GBPushShowSettings(); }
+ (void)changed:(UISwitch *)control {
  if (!GBPushEnvironment()) { GBPushShowSettings(); return; }
  BOOL requested = control.on;
  control.enabled = NO;
  void (^save)(BOOL) = ^(BOOL enabled) {
    GBDeviceRequest(@"PUT", @{@"push":@{@"enabled":enabled ? @YES : @NO}}, ^(NSDictionary *value, NSError *error) {
      control.enabled = YES;
      if (error) control.on = !requested;
      if (enabled && !error) GBPushRefresh();
    });
  };
  if (!requested) { save(NO); return; }
  UNUserNotificationCenter *center = UNUserNotificationCenter.currentNotificationCenter;
  [center getNotificationSettingsWithCompletionHandler:^(UNNotificationSettings *settings) {
    dispatch_async(dispatch_get_main_queue(), ^{
      if (settings.authorizationStatus == UNAuthorizationStatusNotDetermined) {
        [center requestAuthorizationWithOptions:UNAuthorizationOptionAlert|UNAuthorizationOptionSound|UNAuthorizationOptionBadge completionHandler:^(BOOL granted, NSError *error) {
          dispatch_async(dispatch_get_main_queue(), ^{ control.on = granted; save(granted); });
        }];
      } else if (settings.authorizationStatus == UNAuthorizationStatusDenied) {
        control.enabled = YES; control.on = NO; GBPushShowSettings();
      } else save(YES);
    });
  }];
}
@end
static UISwitch *GBNotificationSwitch(UIView *view) {
  UISwitch *control = [view isKindOfClass:UISwitch.class] ? (UISwitch *)view : nil;
  if (!control)
    for (UIView *child in view.subviews)
      if ([child isKindOfClass:UISwitch.class]) { control = (UISwitch *)child; break; }
  return control;
}
void GBResetPushView(UIView *view) {
  UISwitch *control = GBNotificationSwitch(view);
  NSMapTable *targets = objc_getAssociatedObject(control, &GBOriginalSwitchTargets);
  if (targets) {
    [control removeTarget:GBPushEntry.class action:@selector(changed:) forControlEvents:UIControlEventValueChanged];
    for (id target in targets)
      for (NSString *action in [targets objectForKey:target])
        [control addTarget:target action:NSSelectorFromString(action) forControlEvents:UIControlEventValueChanged];
    objc_setAssociatedObject(control, &GBOriginalSwitchTargets, nil, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
  }
  GBPushEntry *entry = (GBPushEntry *)[view viewWithTag:731990];
  if ([entry isKindOfClass:GBPushEntry.class]) {
    entry.originalSwitch.hidden = NO;
    [entry removeFromSuperview];
  }
}
BOOL GBReplacePushView(UIView *view) {
  if (!GBConnection.shared.deviceToken.length) return NO;
  UISwitch *control = GBNotificationSwitch(view);
  if (!control || ![@[@"通知", @"Notifications"] containsObject:control.accessibilityLabel]) return NO;
  NSString *identity = GBPushStateKey();
  NSDictionary *state = [GBDevicePushStateIdentity isEqual:identity] ? GBDevicePushState :
    [NSUserDefaults.standardUserDefaults dictionaryForKey:identity];
  if (GBPushEnvironment()) {
    if (!objc_getAssociatedObject(control, &GBOriginalSwitchTargets)) {
      NSMapTable *targets = NSMapTable.weakToStrongObjectsMapTable;
      for (id target in control.allTargets) {
        NSArray *actions = [control actionsForTarget:target forControlEvent:UIControlEventValueChanged];
        if (actions.count) [targets setObject:actions forKey:target];
      }
      objc_setAssociatedObject(control, &GBOriginalSwitchTargets, targets, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
      [control removeTarget:nil action:nil forControlEvents:UIControlEventValueChanged];
      [control addTarget:GBPushEntry.class action:@selector(changed:) forControlEvents:UIControlEventValueChanged];
    }
    if (state && control.enabled)
      control.on = [state[@"enabled"] boolValue] && [@[@"authorized", @"provisional", @"ephemeral"] containsObject:state[@"authorization"]];
    return YES;
  }
  UIView *row = control.superview;
  while (row && row.bounds.size.width < 300) row = row.superview;
  if (!row || row.bounds.size.height < 40) return NO;
  // Fabric flattens all setting rows into one group. Derive this row from the
  // native switch's position, preserving Appearance/Language rows below it.
  CGRect switchRect = [control convertRect:control.bounds toView:row];
  CGFloat height = MAX(50, switchRect.size.height + 30);
  CGRect rowFrame = CGRectMake(0, MAX(0, CGRectGetMidY(switchRect) - height / 2), row.bounds.size.width, height);
  GBPushEntry *entry = (GBPushEntry *)[row viewWithTag:731990];
  if (!entry) {
    entry = [GBPushEntry buttonWithType:UIButtonTypeCustom];
    entry.tag = 731990; entry.originalSwitch = control;
    entry.autoresizingMask = UIViewAutoresizingFlexibleWidth | UIViewAutoresizingFlexibleHeight;
    entry.stateLabel = [UILabel new]; entry.stateLabel.font = [UIFont systemFontOfSize:17];
    entry.stateLabel.textColor = UIColor.secondaryLabelColor; entry.stateLabel.textAlignment = NSTextAlignmentRight;
    entry.chevron = [[UIImageView alloc] initWithImage:[UIImage systemImageNamed:@"chevron.right"]];
    entry.chevron.tintColor = UIColor.tertiaryLabelColor;
    [entry addSubview:entry.stateLabel]; [entry addSubview:entry.chevron];
    [entry addTarget:entry action:@selector(open) forControlEvents:UIControlEventTouchUpInside];
    row.userInteractionEnabled = YES; [row addSubview:entry];
  }
  control.hidden = YES;
  entry.frame = rowFrame; entry.layer.zPosition = 1000; [row bringSubviewToFront:entry];
  BOOL configured = [state[@"provider"] isEqual:@"bark"] && [state[@"configured"] boolValue];
  entry.stateLabel.text = configured ? GBL(@"Bark 已配置", @"Bark configured") : GBL(@"Bark 未配置", @"Bark not configured");
  entry.stateLabel.frame = CGRectMake(entry.bounds.size.width - 204, (entry.bounds.size.height - 22) / 2, 160, 22);
  entry.chevron.frame = CGRectMake(entry.bounds.size.width - 34, (entry.bounds.size.height - 16) / 2, 10, 16);
  entry.accessibilityLabel = [GBL(@"通知，", @"Notifications, ") stringByAppendingString:entry.stateLabel.text];
  return YES;
}
void GBPushRefresh(void) {
  if (!GBConnection.shared.deviceToken.length) return;
  GBInstallPushDelegate();
  UNUserNotificationCenter *center = UNUserNotificationCenter.currentNotificationCenter;
  [center getNotificationSettingsWithCompletionHandler:^(UNNotificationSettings *s) {
    GBReportDevice(s);
    dispatch_async(dispatch_get_main_queue(), ^{
      if (GBPushEnvironment()) {
        if (s.authorizationStatus == UNAuthorizationStatusNotDetermined && !GBAuthorizing && !GBAuthorizationAttempted) {
          GBAuthorizing = YES; GBAuthorizationAttempted = YES;
          [center requestAuthorizationWithOptions:UNAuthorizationOptionAlert|UNAuthorizationOptionSound|UNAuthorizationOptionBadge completionHandler:^(BOOL granted, NSError *error) {
            dispatch_async(dispatch_get_main_queue(), ^{
              GBAuthorizing = NO;
              if (error) GBRegistrationError = [NSString stringWithFormat:@"%@ (%ld)",error.domain,(long)error.code];
              GBPushRefresh();
            });
          }];
        } else [UIApplication.sharedApplication registerForRemoteNotifications];
      } else if (![NSUserDefaults.standardUserDefaults boolForKey:GBPromptKey()]) {
        GBDeviceRequest(@"GET", nil, ^(NSDictionary *value, NSError *error) {
          if (error) return;
          if ([value[@"push"][@"configured"] boolValue])
            [NSUserDefaults.standardUserDefaults setBool:YES forKey:GBPromptKey()];
          else GBShowBark();
        });
      }
    });
  }];
}

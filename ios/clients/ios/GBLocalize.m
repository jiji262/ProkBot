#import <UIKit/UIKit.h>
#import "GBLocalize.h"
static NSString *GBLocaleKey = @"GrokBotLocal.interfaceLanguage";
BOOL GBIsChinese(void) {
  NSString *language = [NSUserDefaults.standardUserDefaults stringForKey:GBLocaleKey];
  if (!language.length) language = NSLocale.preferredLanguages.firstObject;
  return [language.lowercaseString hasPrefix:@"zh"];
}
NSString *GBL(NSString *chinese, NSString *english) { return GBIsChinese() ? chinese : english; }
void GBObserveAppLanguage(NSString *label) {
  // These labels are emitted by the original Lingui settings/account controls.
  // Observe their resolved language, so an in-app override wins over iOS locale.
  NSString *language = nil;
  if ([@[@"账户", @"调试", @"用量", @"语言", @"连接服务端"] containsObject:label]) language = @"zh";
  if ([@[@"Account", @"Debug", @"Usage", @"Language", @"Connect to Host"] containsObject:label]) language = @"en";
  if (language && ![language isEqual:[NSUserDefaults.standardUserDefaults stringForKey:GBLocaleKey]])
    [NSUserDefaults.standardUserDefaults setObject:language forKey:GBLocaleKey];
}
UIViewController *GBTopController(void) {
  UIViewController *top = nil;
  for (UIScene *scene in UIApplication.sharedApplication.connectedScenes)
    if ([scene isKindOfClass:UIWindowScene.class])
      for (UIWindow *window in ((UIWindowScene *)scene).windows)
        if (window.isKeyWindow) top = window.rootViewController;
  while (top.presentedViewController) top = top.presentedViewController;
  return top;
}
void GBPresentController(UIViewController *controller) {
  UINavigationController *nav = [[UINavigationController alloc] initWithRootViewController:controller];
  nav.modalPresentationStyle = UIModalPresentationPageSheet;
  if (@available(iOS 15.0, *)) {
    nav.sheetPresentationController.detents = @[UISheetPresentationControllerDetent.largeDetent];
    nav.sheetPresentationController.prefersGrabberVisible = YES;
  }
  [GBTopController() presentViewController:nav animated:YES completion:nil];
}

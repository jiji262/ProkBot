#import <Foundation/Foundation.h>
@class UIViewController;
BOOL GBIsChinese(void);
NSString *GBL(NSString *chinese, NSString *english);
void GBObserveAppLanguage(NSString *label);
UIViewController *GBTopController(void);
void GBPresentController(UIViewController *controller);

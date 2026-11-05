#import <UIKit/UIKit.h>
void GBPushRefresh(void);
void GBPushShowSettings(void);
NSString *GBPushEnvironment(void);
void GBReceiveLocalNotification(NSDictionary *notification);
BOOL GBReplacePushView(UIView *view);
void GBResetPushView(UIView *view);
void GBPushSetForeground(BOOL foreground);

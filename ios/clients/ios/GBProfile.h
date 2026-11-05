#import <UIKit/UIKit.h>
void GBRefreshProfile(void);
void GBRestoreProfileCache(void);
void GBClearProfileCache(void);
void GBShowProfile(void);
NSString *GBProfileName(void);
NSString *GBProfileHostName(void);
UIImage *GBProfileAvatar(void);
BOOL GBReplaceProfileView(UIView *view);
void GBResetProfileView(UIView *view);

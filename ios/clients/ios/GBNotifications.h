#import <Foundation/Foundation.h>
@interface GBNotifications : NSObject
+ (instancetype)shared;
- (void)start;
- (void)stop;
@end

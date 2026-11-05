#import <UIKit/UIKit.h>
@interface GBConnection : NSObject
+ (instancetype)shared;
@property(nonatomic, readonly) NSString *serverURL;
@property(nonatomic, readonly) NSString *deviceToken;
@property(nonatomic, readonly) NSURL *gatewayBundleURL;
@property(nonatomic, strong) NSURL *resourcesURL;
@property(nonatomic, copy) void (^didConnect)(void);
@property(nonatomic, copy) void (^didDisconnect)(void);
- (BOOL)restore:(NSError **)error;
- (void)show;
- (void)disconnect;
@end
FOUNDATION_EXPORT void GBReloadReactHost(void);
FOUNDATION_EXPORT void GBOpenAgent(NSString *agentId);

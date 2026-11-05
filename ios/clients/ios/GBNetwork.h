#import <Foundation/Foundation.h>
FOUNDATION_EXPORT NSString *GBNetworkAddress(void);
FOUNDATION_EXPORT BOOL GBNetworkEnabled(void);
FOUNDATION_EXPORT NSString *GBNetworkRestore(NSString *fallback);
FOUNDATION_EXPORT NSString *GBNetworkPrepare(NSString *address, BOOL enabled, NSError **error);
FOUNDATION_EXPORT BOOL GBNetworkCommit(void);
FOUNDATION_EXPORT void GBNetworkRollback(void);
FOUNDATION_EXPORT void GBNetworkClear(void);
FOUNDATION_EXPORT NSDictionary *GBNetworkStatus(void);
FOUNDATION_EXPORT BOOL GBNetworkEnsureReadyForURL(NSURL *url);

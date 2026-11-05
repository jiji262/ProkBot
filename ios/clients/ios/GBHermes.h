#import <Foundation/Foundation.h>
@interface GBHermes : NSObject
+ (NSData *)gatewayData:(NSString *)url
                  token:(NSString *)token
              resources:(NSURL *)resources
                  error:(NSError **)error;
+ (NSURL *)writeGateway:(NSString *)url
                  token:(NSString *)token
              resources:(NSURL *)resources
                  error:(NSError **)error;
@end

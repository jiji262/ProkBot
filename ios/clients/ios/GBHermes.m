#import "GBLocalize.h"
#import "GBHermes.h"
#import <CommonCrypto/CommonDigest.h>

static NSError *GBError(NSString *message) {
  return [NSError errorWithDomain:@"GrokBotLocal"
                             code:1
                         userInfo:@{NSLocalizedDescriptionKey : message}];
}
static NSString *GBSha(NSData *data) {
  unsigned char hash[CC_SHA256_DIGEST_LENGTH];
  CC_SHA256(data.bytes, (CC_LONG)data.length, hash);
  NSMutableString *out = [NSMutableString string];
  for (NSUInteger i = 0; i < sizeof(hash); i++)
    [out appendFormat:@"%02x", hash[i]];
  return out;
}
static void U8(NSMutableData *d, unsigned int n) {
  uint8_t v = n;
  [d appendBytes:&v length:1];
}
static void U16(NSMutableData *d, unsigned int n) {
  uint16_t v = CFSwapInt16HostToLittle(n);
  [d appendBytes:&v length:2];
}
static void U32(NSMutableData *d, unsigned int n) {
  uint32_t v = CFSwapInt32HostToLittle(n);
  [d appendBytes:&v length:4];
}
static void Op(NSMutableData *d, NSDictionary *m, NSString *name) {
  U8(d, [m[@"opcodes"][name] unsignedIntValue]);
}
static void Str(NSMutableData *d, NSDictionary *m, uint8_t reg, uint32_t index) {
  Op(d, m, index < 65536 ? @"LoadConstString" : @"LoadConstStringLongIndex");
  U8(d, reg);
  if (index < 65536)
    U16(d, index);
  else
    U32(d, index);
}
@implementation GBHermes
+ (NSData *)gatewayData:(NSString *)url
                  token:(NSString *)token
              resources:(NSURL *)resources
                  error:(NSError **)error {
  NSData *metaData =
      [NSData dataWithContentsOfURL:[resources URLByAppendingPathComponent:@"gateway-template.json"]
                            options:0
                              error:error];
  if (!metaData)
    return nil;
  NSDictionary *m = [NSJSONSerialization JSONObjectWithData:metaData options:0 error:error];
  NSMutableData *bundle =
      [[NSData dataWithContentsOfURL:[resources URLByAppendingPathComponent:@"gateway-template.hbc"]
                             options:0
                               error:error] mutableCopy];
  if (!bundle)
    return nil;
  if (![m isKindOfClass:NSDictionary.class] ||
      ![m[@"schema"] isEqual:@"grokbot-native-hermes/v1"] ||
      ![GBSha(bundle) isEqual:m[@"templateSha256"]]) {
    if (error)
      *error = GBError(GBL(@"连接模块校验失败，请重新生成客户端。", @"Connection module verification failed."));
    return nil;
  }
  if (!url.length || url.length > 2048 || !token.length || token.length > 1024) {
    if (error)
      *error = GBError(GBL(@"服务器地址或设备凭证长度无效。", @"Invalid Host address or credential."));
    return nil;
  }
  NSMutableData *body = [NSMutableData data];
  Op(body, m, @"NewObject");
  U8(body, 0);
  NSArray *values = @[ url, token ];
  NSArray *keys = @[ m[@"urlKey"], m[@"tokenKey"] ];
  for (NSUInteger cache = 0; cache < 2; cache++) {
    Str(body, m, 1, [m[@"emptyString"] unsignedIntValue]);
    NSString *value = values[cache];
    for (NSUInteger i = 0; i < value.length; i++) {
      unichar c = [value characterAtIndex:i];
      NSNumber *index = m[@"strings"][[NSString stringWithFormat:@"%u", c]];
      if (c < 33 || c > 126) {
        if (error)
          *error = GBError(GBL(@"服务器地址与凭证必须使用 ASCII 字符。", @"The Host address and credential must use ASCII characters."));
        return nil;
      }
      if (index)
        Str(body, m, 2, index.unsignedIntValue);
      else if (c >= '0' && c <= '9') {
        Op(body, m, @"LoadConstUInt8");
        U8(body, 2);
        U8(body, c - '0');
      } else {
        if (error)
          *error = GBError(GBL(@"连接配置包含不支持的字符。", @"Unsupported character in connection configuration."));
        return nil;
      }
      Op(body, m, @"Add");
      U8(body, 1);
      U8(body, 1);
      U8(body, 2);
    }
    uint32_t index = [keys[cache] unsignedIntValue];
    Op(body, m, index < 65536 ? @"DefineOwnById" : @"DefineOwnByIdLong");
    U8(body, 0);
    U8(body, 1);
    U8(body, (unsigned)cache);
    if (index < 65536)
      U16(body, index);
    else
      U32(body, index);
  }
  Op(body, m, @"Ret");
  U8(body, 0);
  NSUInteger offset = [m[@"bodyOffset"] unsignedIntegerValue],
             capacity = [m[@"bodyCapacity"] unsignedIntegerValue],
             lengthOffset = [m[@"bodyLengthOffset"] unsignedIntegerValue];
  if (body.length > capacity || offset + capacity > bundle.length - 20 ||
      lengthOffset + 4 >= bundle.length - 20) {
    if (error)
      *error = GBError(GBL(@"连接模块结构不匹配。", @"Connection module does not match."));
    return nil;
  }
  [bundle replaceBytesInRange:NSMakeRange(offset, body.length) withBytes:body.bytes];
  memset((uint8_t *)bundle.mutableBytes + offset + body.length, 0, capacity - body.length);
  uint32_t size = CFSwapInt32HostToLittle((uint32_t)body.length);
  [bundle replaceBytesInRange:NSMakeRange(lengthOffset, 4) withBytes:&size];
  unsigned char footer[CC_SHA1_DIGEST_LENGTH];
  CC_SHA1(bundle.bytes, (CC_LONG)bundle.length - 20, footer);
  [bundle replaceBytesInRange:NSMakeRange(bundle.length - 20, 20) withBytes:footer];
  return bundle;
}
+ (NSURL *)writeGateway:(NSString *)url
                  token:(NSString *)token
              resources:(NSURL *)resources
                  error:(NSError **)error {
  NSData *bundle = [self gatewayData:url token:token resources:resources error:error];
  if (!bundle)
    return nil;
  NSURL *dir = [[NSFileManager.defaultManager URLsForDirectory:NSCachesDirectory
                                                     inDomains:NSUserDomainMask]
                    .firstObject URLByAppendingPathComponent:@"GrokBotPaired"
                                                 isDirectory:YES];
  if (![NSFileManager.defaultManager
                 createDirectoryAtURL:dir
          withIntermediateDirectories:YES
                           attributes:@{
                             NSFileProtectionKey :
                                 NSFileProtectionCompleteUntilFirstUserAuthentication
                           }
                                error:error])
    return nil;
  NSURL *target = [dir URLByAppendingPathComponent:@"main.jsbundle"];
  if (![bundle writeToURL:target
                  options:NSDataWritingAtomic |
                          NSDataWritingFileProtectionCompleteUntilFirstUserAuthentication
                    error:error])
    return nil;
  [NSFileManager.defaultManager setAttributes:@{NSFilePosixPermissions : @0600}
                                 ofItemAtPath:target.path
                                        error:nil];
  return target;
}
@end

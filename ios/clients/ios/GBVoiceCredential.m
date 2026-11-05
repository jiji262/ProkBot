#import "GBVoiceCredential.h"
BOOL GBVoiceCredentialIsValid(id credential, NSString *serverURL) {
  if (![credential isKindOfClass:NSDictionary.class]) return NO;
  NSString *secret = credential[@"clientSecret"], *model = credential[@"model"], *address = credential[@"websocketUrl"];
  if (![secret isKindOfClass:NSString.class] || secret.length != 43 ||
      ![model isKindOfClass:NSString.class] || !model.length || model.length > 256 ||
      ![address isKindOfClass:NSString.class]) return NO;
  NSCharacterSet *allowed = [NSCharacterSet characterSetWithCharactersInString:@"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-"];
  if ([secret rangeOfCharacterFromSet:allowed.invertedSet].location != NSNotFound) return NO;
  NSURLComponents *host = [NSURLComponents componentsWithString:serverURL];
  NSURLComponents *ws = [NSURLComponents componentsWithString:address];
  BOOL secure = [host.scheme.lowercaseString isEqual:@"https"];
  if (!secure && ![host.scheme.lowercaseString isEqual:@"http"]) return NO;
  if (!ws.host.length || ![ws.host.lowercaseString isEqual:host.host.lowercaseString] ||
      ![ws.scheme.lowercaseString isEqual:secure ? @"wss" : @"ws"] ||
      ![(ws.port ?: @(secure ? 443 : 80)) isEqual:(host.port ?: @(secure ? 443 : 80))] ||
      ws.user.length || ws.password.length || ws.fragment.length || ws.query.length ||
      ![ws.path isEqual:@"/local/voice/realtime"]) return NO;
  return YES;
}

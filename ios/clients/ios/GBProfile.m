#import "GBLocalize.h"
#import "GBProfile.h"
#import "GBConnection.h"
#import "GBNetwork.h"
#import "GBHTTP.h"
#import <PhotosUI/PhotosUI.h>
#import <objc/runtime.h>
#import <CommonCrypto/CommonDigest.h>
static NSDictionary *GBUserProfile;
static UIImage *GBUserAvatar;
static NSString *GBProfileScope;
static char GBOriginalVisibility;
static NSString *GBCurrentProfileScope(void) {
  NSString *scope = [NSString stringWithFormat:@"%@\n%@", (GBNetworkAddress().length ? GBNetworkAddress() : GBConnection.shared.serverURL) ?: @"",
    [NSUserDefaults.standardUserDefaults stringForKey:@"GrokBotLocal.deviceId"] ?: @""];
  NSData *bytes = [scope dataUsingEncoding:NSUTF8StringEncoding]; unsigned char digest[CC_SHA256_DIGEST_LENGTH];
  CC_SHA256(bytes.bytes, (CC_LONG)bytes.length, digest);
  NSMutableString *result = [NSMutableString stringWithCapacity:CC_SHA256_DIGEST_LENGTH * 2];
  for (NSUInteger index = 0; index < CC_SHA256_DIGEST_LENGTH; index++) [result appendFormat:@"%02x", digest[index]];
  return result;
}
static NSURL *GBProfileCacheURL(void) {
  NSURL *directory = [NSFileManager.defaultManager URLsForDirectory:NSApplicationSupportDirectory inDomains:NSUserDomainMask].firstObject;
  return [directory URLByAppendingPathComponent:@"GrokBotLocal-profile.plist"];
}
void GBResetProfileView(UIView *view) {
  for (UIView *child in view.subviews) {
    NSNumber *hidden = objc_getAssociatedObject(child, &GBOriginalVisibility);
    if (hidden) {
      child.hidden = hidden.boolValue;
      objc_setAssociatedObject(child, &GBOriginalVisibility, nil,
                               OBJC_ASSOCIATION_RETAIN_NONATOMIC);
    }
  }
}
NSString *GBProfileName(void) { return GBUserProfile[@"displayName"] ?: GBL(@"本地用户", @"Local user"); }
NSString *GBProfileHostName(void) {
  NSString *value = GBUserProfile[@"hostName"];
  return [value isKindOfClass:NSString.class] && value.length ? value : @"Grok Bot Host";
}
UIImage *GBProfileAvatar(void) { return GBUserAvatar; }
static void GBSetProfile(NSDictionary *value) {
  GBUserProfile = value;
  GBUserAvatar = nil;
  NSString *encoded = value[@"avatarDataUrl"];
  if ([encoded isKindOfClass:NSString.class]) {
    NSRange comma = [encoded rangeOfString:@","];
    if (comma.location != NSNotFound)
      GBUserAvatar = [UIImage
          imageWithData:[[NSData alloc]
                            initWithBase64EncodedString:[encoded
                                                            substringFromIndex:comma.location + 1]
                                                options:0]];
  }
}
void GBRestoreProfileCache(void) {
  NSString *scope = GBCurrentProfileScope();
  if ([GBProfileScope isEqual:scope]) return;
  GBProfileScope = scope;
  GBSetProfile(@{});
  NSData *data = [NSData dataWithContentsOfURL:GBProfileCacheURL()];
  NSDictionary *cache = data ? [NSPropertyListSerialization propertyListWithData:data options:0 format:nil error:nil] : nil;
  NSDictionary *profile = [cache isKindOfClass:NSDictionary.class] ? cache[@"profile"] : nil;
  if ([cache[@"scope"] isEqual:scope] && [profile isKindOfClass:NSDictionary.class] &&
      [profile[@"displayName"] isKindOfClass:NSString.class] && [profile[@"displayName"] length])
    GBSetProfile(profile);
}
void GBClearProfileCache(void) {
  GBProfileScope = nil;
  GBSetProfile(@{});
  [NSFileManager.defaultManager removeItemAtURL:GBProfileCacheURL() error:nil];
}
static void GBSaveProfileCache(void) {
  NSMutableDictionary *profile = [GBUserProfile mutableCopy];
  if (profile[@"avatarDataUrl"] == NSNull.null) [profile removeObjectForKey:@"avatarDataUrl"];
  if (profile[@"updatedAt"] == NSNull.null) [profile removeObjectForKey:@"updatedAt"];
  NSDictionary *cache = @{@"scope":GBProfileScope ?: GBCurrentProfileScope(), @"profile":profile};
  NSData *data = [NSPropertyListSerialization dataWithPropertyList:cache format:NSPropertyListBinaryFormat_v1_0 options:0 error:nil];
  NSURL *url = GBProfileCacheURL();
  [NSFileManager.defaultManager createDirectoryAtURL:url.URLByDeletingLastPathComponent withIntermediateDirectories:YES attributes:nil error:nil];
  [data writeToURL:url options:NSDataWritingAtomic | NSDataWritingFileProtectionCompleteUntilFirstUserAuthentication error:nil];
  [NSFileManager.defaultManager setAttributes:@{NSFilePosixPermissions:@0600} ofItemAtPath:url.path error:nil];
}
static void GBProfileRequest(NSString *method, NSDictionary *body,
                             void (^complete)(NSDictionary *, NSError *)) {
  if (!GBConnection.shared.deviceToken.length)
    return;
  GBRestoreProfileCache();
  NSString *serverURL = GBConnection.shared.serverURL;
  NSString *deviceToken = GBConnection.shared.deviceToken;
  NSMutableURLRequest *r = [NSMutableURLRequest
      requestWithURL:[NSURL URLWithString:[GBConnection.shared.serverURL
                                              stringByAppendingString:@"/local/profile"]]];
  r.HTTPMethod = method;
  r.timeoutInterval = 20;
  [r setValue:[@"Bearer " stringByAppendingString:GBConnection.shared.deviceToken]
      forHTTPHeaderField:@"Authorization"];
  if (body) {
    r.HTTPBody = [NSJSONSerialization dataWithJSONObject:body options:0 error:nil];
    [r setValue:@"application/json" forHTTPHeaderField:@"Content-Type"];
  }
  [[GBHTTPSession()
      dataTaskWithRequest:r
        completionHandler:^(NSData *data, NSURLResponse *response, NSError *error) {
          NSDictionary *value =
              data ? [NSJSONSerialization JSONObjectWithData:data options:0 error:nil] : nil;
          dispatch_async(dispatch_get_main_queue(), ^{
            if (![serverURL isEqual:GBConnection.shared.serverURL] ||
                ![deviceToken isEqual:GBConnection.shared.deviceToken]) return;
            if (error || ((NSHTTPURLResponse *)response).statusCode != 200 ||
                ![value isKindOfClass:NSDictionary.class] ||
                ![value[@"displayName"] isKindOfClass:NSString.class]) {
              if (complete)
                complete(nil,
                         error ?: [NSError errorWithDomain:@"GrokBotProfile" code:1 userInfo:nil]);
              return;
            }
            GBSetProfile(value);
            GBSaveProfileCache();
            [NSNotificationCenter.defaultCenter postNotificationName:@"GrokBotProfileChanged"
                                                              object:nil];
            if (complete)
              complete(value, nil);
          });
        }] resume];
}
void GBRefreshProfile(void) { GBProfileRequest(@"GET", nil, nil); }
@interface GBProfileController : UIViewController <PHPickerViewControllerDelegate>
@property(nonatomic, strong) UITextField *name;
@property(nonatomic, strong) UIButton *avatar;
@property(nonatomic, strong) UILabel *status;
@property(nonatomic, copy) NSString *avatarData;
@end
@implementation GBProfileController
- (void)viewDidLoad {
  [super viewDidLoad];
  self.navigationController.navigationBar.tintColor = UIColor.labelColor;
  self.title = GBL(@"个人资料", @"Profile");
  self.view.backgroundColor = UIColor.systemGroupedBackgroundColor;
  self.navigationItem.leftBarButtonItem =
      [[UIBarButtonItem alloc] initWithBarButtonSystemItem:UIBarButtonSystemItemClose
                                                    target:self
                                                    action:@selector(close)];
  self.navigationItem.rightBarButtonItem =
      [[UIBarButtonItem alloc] initWithTitle:GBL(@"保存", @"Save")
                                       style:UIBarButtonItemStyleDone
                                      target:self
                                      action:@selector(save)];
  self.avatar = [UIButton buttonWithType:UIButtonTypeCustom];
  self.avatar.layer.cornerRadius = 44;
  self.avatar.clipsToBounds = YES;
  self.avatar.backgroundColor = UIColor.secondarySystemGroupedBackgroundColor;
  [self.avatar.heightAnchor constraintEqualToConstant:88].active = YES;
  [self.avatar.widthAnchor constraintEqualToConstant:88].active = YES;
  [self.avatar addTarget:self action:@selector(pick) forControlEvents:UIControlEventTouchUpInside];
  UIView *avatarHolder = [UIView new];
  [avatarHolder.heightAnchor constraintEqualToConstant:104].active = YES;
  self.avatar.translatesAutoresizingMaskIntoConstraints = NO;
  [avatarHolder addSubview:self.avatar];
  [NSLayoutConstraint activateConstraints:@[
    [self.avatar.centerXAnchor constraintEqualToAnchor:avatarHolder.centerXAnchor],
    [self.avatar.topAnchor constraintEqualToAnchor:avatarHolder.topAnchor]
  ]];
  self.name = [UITextField new];
  self.name.text = GBProfileName();
  self.name.placeholder = GBL(@"用户名", @"Name");
  self.name.backgroundColor = UIColor.secondarySystemGroupedBackgroundColor;
  self.name.layer.cornerRadius = 16;
  self.name.font = [UIFont preferredFontForTextStyle:UIFontTextStyleBody];
  self.name.leftView = [[UIView alloc] initWithFrame:CGRectMake(0, 0, 16, 1)];
  self.name.leftViewMode = UITextFieldViewModeAlways;
  [self.name.heightAnchor constraintEqualToConstant:52].active = YES;
  self.status = [UILabel new];
  self.status.text = @"";
  self.status.textColor = UIColor.secondaryLabelColor;
  self.status.numberOfLines = 0;
  self.status.font = [UIFont preferredFontForTextStyle:UIFontTextStyleFootnote];
  UIButton *remove = [UIButton buttonWithType:UIButtonTypeSystem];
  [remove setTitle:GBL(@"移除头像", @"Remove photo") forState:UIControlStateNormal];
  [remove setTitleColor:UIColor.secondaryLabelColor forState:UIControlStateNormal];
  [remove addTarget:self
                action:@selector(clearAvatar)
      forControlEvents:UIControlEventTouchUpInside];
  UIStackView *stack = [[UIStackView alloc]
      initWithArrangedSubviews:@[ avatarHolder, self.name, remove, self.status ]];
  stack.axis = UILayoutConstraintAxisVertical;
  stack.spacing = 18;
  stack.translatesAutoresizingMaskIntoConstraints = NO;
  [self.view addSubview:stack];
  [NSLayoutConstraint activateConstraints:@[
    [stack.leadingAnchor constraintEqualToAnchor:self.view.leadingAnchor constant:24],
    [stack.trailingAnchor constraintEqualToAnchor:self.view.trailingAnchor constant:-24],
    [stack.topAnchor constraintEqualToAnchor:self.view.safeAreaLayoutGuide.topAnchor constant:24]
  ]];
  self.avatarData = [GBUserProfile[@"avatarDataUrl"] isKindOfClass:NSString.class]
                        ? GBUserProfile[@"avatarDataUrl"]
                        : nil;
  [self paint:GBProfileAvatar()];
  GBProfileRequest(@"GET", nil, ^(NSDictionary *value, NSError *error) {
    if (!error) {
      self.name.text = GBProfileName();
      self.avatarData =
          [value[@"avatarDataUrl"] isKindOfClass:NSString.class] ? value[@"avatarDataUrl"] : nil;
      [self paint:GBProfileAvatar()];
    }
  });
}
- (void)paint:(UIImage *)image {
  [self.avatar setImage:image forState:UIControlStateNormal];
  [self.avatar setTitle:image ? @"" : GBL(@"选择头像", @"Choose photo") forState:UIControlStateNormal];
}
- (void)close {
  [self dismissViewControllerAnimated:YES completion:nil];
}
- (void)clearAvatar {
  self.avatarData = nil;
  [self paint:nil];
}
- (void)pick {
  PHPickerConfiguration *c = [PHPickerConfiguration new];
  c.selectionLimit = 1;
  c.filter = PHPickerFilter.imagesFilter;
  PHPickerViewController *p = [[PHPickerViewController alloc] initWithConfiguration:c];
  p.delegate = self;
  [self presentViewController:p animated:YES completion:nil];
}
- (void)picker:(PHPickerViewController *)picker
    didFinishPicking:(NSArray<PHPickerResult *> *)results {
  [picker dismissViewControllerAnimated:YES completion:nil];
  NSItemProvider *provider = results.firstObject.itemProvider;
  if (![provider canLoadObjectOfClass:UIImage.class])
    return;
  [provider loadObjectOfClass:UIImage.class
            completionHandler:^(id<NSItemProviderReading> object, NSError *error) {
              if (error || ![object isKindOfClass:UIImage.class])
                return;
              UIImage *source = (UIImage *)object;
              dispatch_async(dispatch_get_main_queue(), ^{
                UIGraphicsImageRenderer *r =
                    [[UIGraphicsImageRenderer alloc] initWithSize:CGSizeMake(256, 256)];
                UIImage *image = [r imageWithActions:^(UIGraphicsImageRendererContext *c) {
                  CGFloat scale = MAX(256 / source.size.width, 256 / source.size.height);
                  CGSize size = CGSizeMake(source.size.width * scale, source.size.height * scale);
                  [source drawInRect:CGRectMake((256 - size.width) / 2, (256 - size.height) / 2,
                                                size.width, size.height)];
                }];
                self.avatarData = [@"data:image/png;base64,"
                    stringByAppendingString:[UIImagePNGRepresentation(image)
                                                base64EncodedStringWithOptions:0]];
                [self paint:image];
              });
            }];
}
- (void)save {
  NSString *name = [self.name.text
      stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet];
  if (!name.length || name.length > 80) {
    self.status.text = GBL(@"请输入 1–80 个字符的用户名。", @"Enter a name with 1–80 characters.");
    return;
  }
  self.navigationItem.rightBarButtonItem.enabled = NO;
  self.status.text = GBL(@"正在保存…", @"Saving…");
  GBProfileRequest(@"PUT",
                   @{@"displayName" : name, @"avatarDataUrl" : self.avatarData ?: NSNull.null},
                   ^(NSDictionary *value, NSError *error) {
                     self.navigationItem.rightBarButtonItem.enabled = YES;
                     if (error) {
                       self.status.text = GBL(@"保存失败，请重试。", @"Could not save. Try again.");
                       return;
                     }
                     [self close];
                   });
}
@end
void GBShowProfile(void) {
  UIViewController *top = nil;
  for (UIScene *s in UIApplication.sharedApplication.connectedScenes)
    if ([s isKindOfClass:UIWindowScene.class])
      for (UIWindow *w in ((UIWindowScene *)s).windows)
        if (w.isKeyWindow)
          top = w.rootViewController;
  while (top.presentedViewController)
    top = top.presentedViewController;
  [top presentViewController:[[UINavigationController alloc]
                                 initWithRootViewController:[GBProfileController new]]
                    animated:YES
                  completion:nil];
}

// The pinned Hermes adapter has a local synthetic user; replace only its two
// exact native surfaces so Bot identities and other original controls remain native.
@interface GBProfileEntry : NSObject
+ (void)open;
@end
@implementation GBProfileEntry
+ (void)open {
  GBShowProfile();
}
@end
BOOL GBReplaceProfileView(UIView *view) {
  if (!GBConnection.shared.deviceToken.length)
    return NO;
  NSString *label = view.accessibilityLabel;
  BOOL avatar = [label isEqual:@"dev-gateway@localhost avatar"];
  BOOL row = [label isEqual:@"dev-gateway@localhost"] && view.bounds.size.width > 300 &&
             view.bounds.size.height > 50;
  if (!avatar && !row)
    return NO;
  UIView *cover = [view viewWithTag:731993];
  if (!cover) {
    cover = row ? [UIButton buttonWithType:UIButtonTypeCustom] : [UIView new];
    cover.tag = 731993;
    cover.frame = view.bounds;
    cover.autoresizingMask = UIViewAutoresizingFlexibleWidth | UIViewAutoresizingFlexibleHeight;
    cover.backgroundColor = [UIColor colorWithDynamicProvider:^UIColor *(UITraitCollection *t) {
      return t.userInterfaceStyle == UIUserInterfaceStyleDark ? [UIColor colorWithWhite:.17 alpha:1]
                                                              : UIColor.whiteColor;
    }];
    if (row) {
      [(UIButton *)cover addTarget:GBProfileEntry.class
                            action:@selector(open)
                  forControlEvents:UIControlEventTouchUpInside];
      view.userInteractionEnabled = YES;
    } else {
      cover.userInteractionEnabled = NO;
      cover.layer.cornerRadius = view.bounds.size.width / 2;
      cover.clipsToBounds = YES;
    }
    UIImageView *image = [UIImageView new];
    image.tag = 731994;
    image.contentMode = UIViewContentModeScaleAspectFill;
    image.clipsToBounds = YES;
    [cover addSubview:image];
    UILabel *initial = [UILabel new];
    initial.tag = 731995;
    initial.textAlignment = NSTextAlignmentCenter;
    initial.font = [UIFont systemFontOfSize:17 weight:UIFontWeightMedium];
    initial.textColor = UIColor.secondaryLabelColor;
    [cover addSubview:initial];
    if (row) {
      UILabel *name = [UILabel new];
      name.tag = 731996;
      name.font = [UIFont systemFontOfSize:17];
      name.textColor = UIColor.labelColor;
      [cover addSubview:name];
      UILabel *subtitle = [UILabel new];
      subtitle.tag = 731997;
      subtitle.font = [UIFont systemFontOfSize:14];
      subtitle.textColor = UIColor.secondaryLabelColor;
      [cover addSubview:subtitle];
      UIImageView *chevron =
          [[UIImageView alloc] initWithImage:[UIImage systemImageNamed:@"chevron.right"]];
      chevron.tag = 731998;
      chevron.tintColor = UIColor.tertiaryLabelColor;
      [cover addSubview:chevron];
    }
    [view addSubview:cover];
  }
  cover.layer.zPosition = 1000;
  [view bringSubviewToFront:cover];
  if (avatar) {
    for (UIView *child in view.subviews) {
      if (child == cover)
        continue;
      if (!objc_getAssociatedObject(child, &GBOriginalVisibility))
        objc_setAssociatedObject(child, &GBOriginalVisibility, @(child.hidden),
                                 OBJC_ASSOCIATION_RETAIN_NONATOMIC);
      child.hidden = YES;
    }
  }
  if (avatar) {
    // Fabric renders the original letter as an absolute-positioned sibling of
    // its image. Hide only that text inside the avatar rectangle, not row text.
    UIView *container = view.superview;
    CGRect avatarRect = [view convertRect:view.bounds toView:container];
    for (UIView *sibling in container.subviews) {
      if (sibling == view || ![NSStringFromClass(sibling.class) isEqual:@"RCTParagraphComponentView"])
        continue;
      CGRect textRect = [sibling convertRect:sibling.bounds toView:container];
      if (!CGRectContainsRect(avatarRect, textRect)) continue;
      if (!objc_getAssociatedObject(sibling, &GBOriginalVisibility))
        objc_setAssociatedObject(sibling, &GBOriginalVisibility, @(sibling.hidden),
                                 OBJC_ASSOCIATION_RETAIN_NONATOMIC);
      sibling.hidden = YES;
    }
  }
  CGRect imageFrame = row ? CGRectMake(18, 15, 40, 40) : cover.bounds;
  UIImageView *image = (UIImageView *)[cover viewWithTag:731994];
  image.frame = imageFrame;
  image.layer.cornerRadius = imageFrame.size.width / 2;
  image.image = GBProfileAvatar();
  image.backgroundColor = UIColor.tertiarySystemGroupedBackgroundColor;
  UILabel *initial = (UILabel *)[cover viewWithTag:731995];
  initial.frame = imageFrame;
  initial.hidden = image.image != nil;
  initial.text = [GBProfileName()
      substringWithRange:[GBProfileName() rangeOfComposedCharacterSequenceAtIndex:0]];
  if (row) {
    UILabel *name = (UILabel *)[cover viewWithTag:731996];
    name.frame = CGRectMake(68, 14, cover.bounds.size.width - 112, 22);
    name.text = GBProfileName();
    UILabel *subtitle = (UILabel *)[cover viewWithTag:731997];
    subtitle.frame = CGRectMake(68, 38, cover.bounds.size.width - 112, 18);
    subtitle.text = GBProfileHostName();
    [cover viewWithTag:731998].frame = CGRectMake(cover.bounds.size.width - 34, 27, 10, 16);
    cover.accessibilityLabel = [NSString stringWithFormat:GBL(@"个人资料，%@", @"Profile, %@"), GBProfileName()];
  }
  return YES;
}

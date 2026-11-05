#import "GBLocalize.h"
#import "GBLibrary.h"
#import "GBConnection.h"
#import "GBHTTP.h"
#import <QuickLook/QuickLook.h>
#import <UniformTypeIdentifiers/UniformTypeIdentifiers.h>

static NSString *GBCurrentAgent;
void GBObserveRequest(NSURLRequest *request) {
  if (![request.URL.path hasPrefix:@"/api/"] || !request.HTTPBody)
    return;
  NSDictionary *body = [NSJSONSerialization JSONObjectWithData:request.HTTPBody
                                                       options:0
                                                         error:nil];
  NSString *agent = [body isKindOfClass:NSDictionary.class] ? body[@"id"] : nil;
  if ([agent isKindOfClass:NSString.class] && agent.length && [request.URL.lastPathComponent isEqual:@"openAgentWindowed"])
    dispatch_async(dispatch_get_main_queue(), ^{ GBCurrentAgent = agent; });
}
@interface GBLibraryController
    : UITableViewController <UIDocumentPickerDelegate, QLPreviewControllerDataSource>
@property(nonatomic, copy) NSString *agentId;
@property(nonatomic, copy) NSArray<NSDictionary *> *files;
@property(nonatomic, strong) NSURL *previewURL;
@property(nonatomic, strong) UILabel *status;
@end
@implementation GBLibraryController
- (void)viewDidLoad {
  [super viewDidLoad];
  self.navigationController.navigationBar.tintColor = UIColor.labelColor;
  self.title = GBL(@"资料库", @"Library");
  self.files = @[];
  self.navigationItem.leftBarButtonItem =
      [[UIBarButtonItem alloc] initWithBarButtonSystemItem:UIBarButtonSystemItemClose
                                                    target:self
                                                    action:@selector(close)];
  self.navigationItem.rightBarButtonItem =
      [[UIBarButtonItem alloc] initWithBarButtonSystemItem:UIBarButtonSystemItemAdd
                                                    target:self
                                                    action:@selector(add)];
  self.refreshControl = [UIRefreshControl new];
  [self.refreshControl addTarget:self
                          action:@selector(reload)
                forControlEvents:UIControlEventValueChanged];
  self.status = [UILabel new];
  self.status.numberOfLines = 0;
  self.status.textAlignment = NSTextAlignmentCenter;
  self.status.textColor = UIColor.secondaryLabelColor;
  self.status.font = [UIFont preferredFontForTextStyle:UIFontTextStyleFootnote];
  self.status.frame = CGRectMake(0, 0, self.view.bounds.size.width, 72);
  self.tableView.tableFooterView = self.status;
  [self reload];
}
- (void)close {
  [self dismissViewControllerAnimated:YES completion:nil];
}
- (void)request:(NSString *)method
           path:(NSString *)path
           body:(NSDictionary *)body
       complete:(void (^)(NSData *, NSHTTPURLResponse *, NSError *))complete {
  NSMutableURLRequest *r =
      [NSMutableURLRequest requestWithURL:[NSURL URLWithString:[GBConnection.shared.serverURL
                                                                   stringByAppendingString:path]]];
  r.HTTPMethod = method;
  r.timeoutInterval = 30;
  [r setValue:[@"Bearer " stringByAppendingString:GBConnection.shared.deviceToken ?: @""]
      forHTTPHeaderField:@"Authorization"];
  if (body) {
    r.HTTPBody = [NSJSONSerialization dataWithJSONObject:body options:0 error:nil];
    [r setValue:@"application/json" forHTTPHeaderField:@"Content-Type"];
  }
  [[GBHTTPSession() dataTaskWithRequest:r
                      completionHandler:^(NSData *data, NSURLResponse *response, NSError *error) {
                        dispatch_async(dispatch_get_main_queue(), ^{
                          complete(data, (NSHTTPURLResponse *)response, error);
                        });
                      }] resume];
}
- (NSString *)encoded:(NSString *)s {
  return [s stringByAddingPercentEncodingWithAllowedCharacters:
                [NSCharacterSet
                    characterSetWithCharactersInString:
                        @"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~"]];
}
- (void)reload {
  self.status.text = GBL(@"正在读取…", @"Loading…");
  [self request:@"GET"
           path:[@"/local/files?agentId=" stringByAppendingString:[self encoded:self.agentId]]
           body:nil
       complete:^(NSData *data, NSHTTPURLResponse *r, NSError *error) {
         [self.refreshControl endRefreshing];
         NSDictionary *value =
             data ? [NSJSONSerialization JSONObjectWithData:data options:0 error:nil] : nil;
         if (error || r.statusCode != 200 || ![value[@"files"] isKindOfClass:NSArray.class]) {
           self.status.text = GBL(@"加载失败，下拉重试。", @"Could not load. Pull to retry.");
           return;
         }
         self.files = value[@"files"];
         self.status.text = self.files.count ? @""
                                             : GBL(@"暂无文件", @"No files yet");
         [self.tableView reloadData];
       }];
}
- (NSInteger)tableView:(UITableView *)tableView numberOfRowsInSection:(NSInteger)section {
  return self.files.count;
}
- (UITableViewCell *)tableView:(UITableView *)tableView
         cellForRowAtIndexPath:(NSIndexPath *)indexPath {
  UITableViewCell *cell = [tableView dequeueReusableCellWithIdentifier:@"file"]
                              ?: [[UITableViewCell alloc] initWithStyle:UITableViewCellStyleSubtitle
                                                        reuseIdentifier:@"file"];
  NSDictionary *file = self.files[indexPath.row];
  cell.textLabel.text = file[@"name"];
  cell.detailTextLabel.text =
      [NSByteCountFormatter stringFromByteCount:[file[@"sizeBytes"] longLongValue]
                                     countStyle:NSByteCountFormatterCountStyleFile];
  cell.imageView.image = [UIImage systemImageNamed:@"doc.text"];
  cell.accessoryType = UITableViewCellAccessoryDisclosureIndicator;
  return cell;
}
- (void)tableView:(UITableView *)tableView didSelectRowAtIndexPath:(NSIndexPath *)indexPath {
  [tableView deselectRowAtIndexPath:indexPath animated:YES];
  NSDictionary *file = self.files[indexPath.row];
  self.status.text = GBL(@"正在打开…", @"Opening…");
  NSString *path =
      [NSString stringWithFormat:@"/local/files/content?agentId=%@&name=%@",
                                 [self encoded:self.agentId], [self encoded:file[@"name"]]];
  [self request:@"GET"
           path:path
           body:nil
       complete:^(NSData *data, NSHTTPURLResponse *r, NSError *error) {
         if (error || r.statusCode != 200) {
           self.status.text = GBL(@"无法打开文件，请重试。", @"Could not open the file. Try again.");
           return;
         }
         NSURL *dir = [[NSFileManager.defaultManager URLsForDirectory:NSCachesDirectory
                                                            inDomains:NSUserDomainMask]
                           .firstObject URLByAppendingPathComponent:@"GrokBotFilePreview"
                                                        isDirectory:YES];
         [NSFileManager.defaultManager
                    createDirectoryAtURL:dir
             withIntermediateDirectories:YES
                              attributes:@{
                                NSFileProtectionKey :
                                    NSFileProtectionCompleteUntilFirstUserAuthentication
                              }
                                   error:nil];
         self.previewURL = [dir URLByAppendingPathComponent:[file[@"name"] lastPathComponent]];
         [data writeToURL:self.previewURL options:NSDataWritingAtomic error:nil];
         self.status.text = @"";
         NSString *text = [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding];
         if (text && ([file[@"contentType"] hasPrefix:@"text/"] ||
                      [@[ @"txt", @"md", @"json", @"csv", @"log" ]
                          containsObject:[file[@"name"] pathExtension].lowercaseString])) {
           UIViewController *reader = [UIViewController new];
           reader.title = file[@"name"];
           UITextView *content = [[UITextView alloc] initWithFrame:reader.view.bounds];
           content.autoresizingMask =
               UIViewAutoresizingFlexibleWidth | UIViewAutoresizingFlexibleHeight;
           content.editable = NO;
           content.text = text;
           content.font = [UIFont monospacedSystemFontOfSize:16 weight:UIFontWeightRegular];
           content.backgroundColor = UIColor.systemGroupedBackgroundColor;
           content.textColor = UIColor.labelColor;
           content.textContainerInset = UIEdgeInsetsMake(24, 20, 24, 20);
           [reader.view addSubview:content];
           [self.navigationController pushViewController:reader animated:YES];
         } else {
           QLPreviewController *preview = [QLPreviewController new];
           preview.dataSource = self;
           [self.navigationController pushViewController:preview animated:YES];
         }
       }];
}
- (NSInteger)numberOfPreviewItemsInPreviewController:(QLPreviewController *)controller {
  return self.previewURL ? 1 : 0;
}
- (id<QLPreviewItem>)previewController:(QLPreviewController *)controller
                    previewItemAtIndex:(NSInteger)index {
  return self.previewURL;
}
- (void)tableView:(UITableView *)tableView
    commitEditingStyle:(UITableViewCellEditingStyle)style
     forRowAtIndexPath:(NSIndexPath *)indexPath {
  if (style != UITableViewCellEditingStyleDelete)
    return;
  NSString *name = self.files[indexPath.row][@"name"];
  [self request:@"DELETE"
           path:@"/local/files"
           body:@{@"agentId" : self.agentId, @"name" : name}
       complete:^(NSData *data, NSHTTPURLResponse *r, NSError *error) {
         if (error || r.statusCode != 200) {
           self.status.text = GBL(@"删除失败，请重试。", @"Could not delete. Try again.");
           return;
         }
         [self reload];
       }];
}
- (void)upload:(NSData *)data name:(NSString *)name mime:(NSString *)mime {
  if (data.length > 20 * 1024 * 1024) {
    self.status.text = GBL(@"单个文件最大为 20 MiB。", @"Files can be up to 20 MiB.");
    return;
  }
  self.status.text = GBL(@"正在上传…", @"Uploading…");
  [self request:@"POST"
           path:@"/local/files"
           body:@{
             @"agentId" : self.agentId,
             @"fileName" : name,
             @"contentType" : mime ?: @"application/octet-stream",
             @"base64" : [data base64EncodedStringWithOptions:0]
           }
       complete:^(NSData *data, NSHTTPURLResponse *r, NSError *error) {
         if (error || r.statusCode != 200) {
           self.status.text = GBL(@"上传失败，请重试。", @"Could not upload. Try again.");
           return;
         }
         [self reload];
       }];
}
- (void)add {
  UIAlertController *sheet =
      [UIAlertController alertControllerWithTitle:GBL(@"添加资料", @"Add to library")
                                          message:nil
                                   preferredStyle:UIAlertControllerStyleActionSheet];
  [sheet addAction:[UIAlertAction actionWithTitle:GBL(@"选择文件", @"Choose file")
                                            style:UIAlertActionStyleDefault
                                          handler:^(UIAlertAction *a) {
                                            UIDocumentPickerViewController *picker =
                                                [[UIDocumentPickerViewController alloc]
                                                    initForOpeningContentTypes:@[ UTTypeItem ]
                                                                        asCopy:YES];
                                            picker.delegate = self;
                                            [self presentViewController:picker
                                                               animated:YES
                                                             completion:nil];
                                          }]];
  [sheet
      addAction:[UIAlertAction
                    actionWithTitle:GBL(@"添加文本", @"Add text")
                              style:UIAlertActionStyleDefault
                            handler:^(UIAlertAction *a) {
                              UIAlertController *form = [UIAlertController
                                  alertControllerWithTitle:GBL(@"添加文本", @"Add text")
                                                   message:nil
                                            preferredStyle:UIAlertControllerStyleAlert];
                              [form addTextFieldWithConfigurationHandler:^(UITextField *f) {
                                f.placeholder = GBL(@"文件名.txt", @"Filename.txt");
                                f.autocorrectionType = UITextAutocorrectionTypeNo;
                              }];
                              [form addTextFieldWithConfigurationHandler:^(UITextField *f) {
                                f.placeholder = GBL(@"内容", @"Content");
                              }];
                              [form
                                  addAction:[UIAlertAction actionWithTitle:GBL(@"取消", @"Cancel")
                                                                     style:UIAlertActionStyleCancel
                                                                   handler:nil]];
                              [form
                                  addAction:[UIAlertAction
                                                actionWithTitle:GBL(@"上传", @"Upload")
                                                          style:UIAlertActionStyleDefault
                                                        handler:^(UIAlertAction *action) {
                                                          NSString *name = form.textFields[0].text;
                                                          NSString *value = form.textFields[1].text;
                                                          if (name.length && value.length)
                                                            [self
                                                                upload:[value
                                                                           dataUsingEncoding:
                                                                               NSUTF8StringEncoding]
                                                                  name:name
                                                                  mime:@"text/plain"];
                                                          else
                                                            self.status.text =
                                                                GBL(@"文件名和内容不能为空。", @"Enter a filename and content.");
                                                        }]];
                              [self presentViewController:form animated:YES completion:nil];
                            }]];
  [sheet addAction:[UIAlertAction actionWithTitle:GBL(@"取消", @"Cancel")
                                            style:UIAlertActionStyleCancel
                                          handler:nil]];
  sheet.popoverPresentationController.barButtonItem = self.navigationItem.rightBarButtonItem;
  [self presentViewController:sheet animated:YES completion:nil];
}
- (void)documentPicker:(UIDocumentPickerViewController *)controller
    didPickDocumentsAtURLs:(NSArray<NSURL *> *)urls {
  NSURL *url = urls.firstObject;
  if (!url)
    return;
  BOOL scoped = [url startAccessingSecurityScopedResource];
  NSError *error = nil;
  NSData *data = [NSData dataWithContentsOfURL:url options:NSDataReadingMappedIfSafe error:&error];
  if (scoped)
    [url stopAccessingSecurityScopedResource];
  if (!data) {
    self.status.text = GBL(@"无法读取所选文件。", @"Could not read this file.");
    return;
  }
  [self upload:data
          name:url.lastPathComponent
          mime:[UTType typeWithFilenameExtension:url.pathExtension].preferredMIMEType];
}
@end
void GBShowLibrary(void) {
  if (!GBCurrentAgent.length)
    return;
  UIViewController *top = nil;
  for (UIScene *s in UIApplication.sharedApplication.connectedScenes)
    if ([s isKindOfClass:UIWindowScene.class])
      for (UIWindow *w in ((UIWindowScene *)s).windows)
        if (w.isKeyWindow)
          top = w.rootViewController;
  while (top.presentedViewController)
    top = top.presentedViewController;
  GBLibraryController *vc =
      [[GBLibraryController alloc] initWithStyle:UITableViewStyleInsetGrouped];
  vc.agentId = GBCurrentAgent;
  [top presentViewController:[[UINavigationController alloc] initWithRootViewController:vc]
                    animated:YES
                  completion:nil];
}

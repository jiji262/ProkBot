#import "GBUsage.h"
#import "GBConnection.h"
#import "GBHTTP.h"
#import "GBLocalize.h"
@interface GBUsageController : UITableViewController
@property(nonatomic, copy) NSDictionary *usage;
@property(nonatomic, copy) NSString *status;
@end
@implementation GBUsageController
- (void)viewDidLoad {
  [super viewDidLoad];
  self.title = GBL(@"今日用量", @"Today's usage");
  self.navigationController.navigationBar.tintColor = UIColor.labelColor;
  self.navigationItem.leftBarButtonItem = [[UIBarButtonItem alloc] initWithBarButtonSystemItem:UIBarButtonSystemItemClose target:self action:@selector(close)];
  self.refreshControl = [UIRefreshControl new];
  [self.refreshControl addTarget:self action:@selector(reload) forControlEvents:UIControlEventValueChanged];
  [self reload];
}
- (void)close { [self dismissViewControllerAnimated:YES completion:nil]; }
- (void)reload {
  self.status = GBL(@"正在加载…", @"Loading…");
  NSString *zone = [NSTimeZone.localTimeZone.name stringByAddingPercentEncodingWithAllowedCharacters:NSCharacterSet.URLQueryAllowedCharacterSet];
  NSURL *url = [NSURL URLWithString:[GBConnection.shared.serverURL stringByAppendingFormat:@"/local/usage?timeZone=%@", zone]];
  NSMutableURLRequest *request = [NSMutableURLRequest requestWithURL:url]; request.timeoutInterval = 20;
  NSString *token = GBConnection.shared.deviceToken;
  [request setValue:[@"Bearer " stringByAppendingString:token ?: @""] forHTTPHeaderField:@"Authorization"];
  [[GBHTTPSession() dataTaskWithRequest:request completionHandler:^(NSData *data, NSURLResponse *response, NSError *error) {
    id value = data ? [NSJSONSerialization JSONObjectWithData:data options:0 error:nil] : nil;
    dispatch_async(dispatch_get_main_queue(), ^{
      [self.refreshControl endRefreshing];
      if (![token isEqual:GBConnection.shared.deviceToken]) return;
      if (error || ((NSHTTPURLResponse *)response).statusCode != 200 || ![value isKindOfClass:NSDictionary.class] || ![value[@"total"] isKindOfClass:NSNumber.class]) {
        self.status = GBL(@"加载失败，下拉重试。", @"Could not load. Pull to retry.");
      } else { self.usage = value; self.status = nil; }
      [self.tableView reloadData];
    });
  }] resume];
}
- (NSInteger)numberOfSectionsInTableView:(UITableView *)tableView { return self.usage ? 2 : 1; }
- (NSInteger)tableView:(UITableView *)tableView numberOfRowsInSection:(NSInteger)section { return section == 0 ? 1 : 2; }
- (NSString *)tableView:(UITableView *)tableView titleForFooterInSection:(NSInteger)section {
  return section == 0 && self.usage && ![self.usage[@"total"] longLongValue] ? GBL(@"今天暂无用量", @"No usage today") : nil;
}
- (UITableViewCell *)tableView:(UITableView *)tableView cellForRowAtIndexPath:(NSIndexPath *)path {
  UITableViewCell *cell = [[UITableViewCell alloc] initWithStyle:UITableViewCellStyleValue1 reuseIdentifier:nil];
  cell.selectionStyle = UITableViewCellSelectionStyleNone;
  if (!self.usage) { cell.textLabel.text = self.status; return cell; }
  NSNumberFormatter *format = [NSNumberFormatter new]; format.numberStyle = NSNumberFormatterDecimalStyle;
  format.locale = [NSLocale localeWithLocaleIdentifier:GBIsChinese() ? @"zh_CN" : @"en_US"];
  NSString *key = path.section == 0 ? @"total" : path.row == 0 ? @"input" : @"output";
  cell.textLabel.text = path.section == 0 ? @"Token" : path.row == 0 ? GBL(@"输入", @"Input") : GBL(@"输出", @"Output");
  cell.detailTextLabel.text = [format stringFromNumber:self.usage[key] ?: @0];
  cell.detailTextLabel.textColor = UIColor.labelColor;
  cell.detailTextLabel.font = [UIFont monospacedDigitSystemFontOfSize:path.section == 0 ? 28 : 17 weight:path.section == 0 ? UIFontWeightSemibold : UIFontWeightRegular];
  cell.accessibilityIdentifier = [@"grokbot.usage." stringByAppendingString:key];
  return cell;
}
- (CGFloat)tableView:(UITableView *)tableView heightForRowAtIndexPath:(NSIndexPath *)path { return path.section == 0 && self.usage ? 88 : 52; }
@end
@interface GBUsageEntry : NSObject
@end
@implementation GBUsageEntry
+ (void)open { GBPresentController([[GBUsageController alloc] initWithStyle:UITableViewStyleInsetGrouped]); }
@end
BOOL GBReplaceUsageView(UIView *view) {
  if (!GBConnection.shared.deviceToken.length || ![@[@"用量", @"Usage"] containsObject:view.accessibilityLabel] || view.bounds.size.width < 300 || view.bounds.size.height < 44) return NO;
  UIButton *button = (UIButton *)[view viewWithTag:731989];
  if (!button) {
    button = [UIButton buttonWithType:UIButtonTypeCustom]; button.tag = 731989;
    button.autoresizingMask = UIViewAutoresizingFlexibleWidth | UIViewAutoresizingFlexibleHeight;
    [button addTarget:GBUsageEntry.class action:@selector(open) forControlEvents:UIControlEventTouchUpInside];
    view.userInteractionEnabled = YES; [view addSubview:button];
  }
  button.frame = view.bounds; button.accessibilityLabel = GBL(@"用量", @"Usage");
  button.accessibilityIdentifier = @"grokbot.usage.open";
  return YES;
}

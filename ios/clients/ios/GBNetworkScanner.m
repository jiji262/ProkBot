#import "GBNetworkScanner.h"
#import "GBLocalize.h"
#import <AVFoundation/AVFoundation.h>

@interface GBNetworkScanner : UIViewController <AVCaptureMetadataOutputObjectsDelegate>
@property(nonatomic, strong) AVCaptureSession *session;
@property(nonatomic, strong) AVCaptureVideoPreviewLayer *preview;
@property(nonatomic, copy) void (^completion)(NSString *address);
@property(nonatomic, assign) BOOL finished;
@end
@implementation GBNetworkScanner
- (void)viewDidLoad {
  [super viewDidLoad]; self.view.backgroundColor = UIColor.blackColor;
  self.title = GBL(@"扫描连接二维码", @"Scan connection code");
  self.navigationItem.leftBarButtonItem = [[UIBarButtonItem alloc] initWithBarButtonSystemItem:UIBarButtonSystemItemClose target:self action:@selector(close)];
  [AVCaptureDevice requestAccessForMediaType:AVMediaTypeVideo completionHandler:^(BOOL granted) {
    dispatch_async(dispatch_get_main_queue(), ^{
      if (self.finished) return;
      if (!granted) {
        UIAlertController *alert = [UIAlertController alertControllerWithTitle:GBL(@"允许使用相机", @"Allow camera access") message:GBL(@"在系统设置中允许相机访问。", @"Allow camera access in Settings.") preferredStyle:UIAlertControllerStyleAlert];
        [alert addAction:[UIAlertAction actionWithTitle:GBL(@"关闭", @"Close") style:UIAlertActionStyleCancel handler:^(UIAlertAction *a) { [self close]; }]];
        [self presentViewController:alert animated:YES completion:nil]; return;
      }
      self.session = [AVCaptureSession new];
      AVCaptureDeviceInput *input = [AVCaptureDeviceInput deviceInputWithDevice:[AVCaptureDevice defaultDeviceWithMediaType:AVMediaTypeVideo] error:nil];
      if (!input || ![self.session canAddInput:input]) { [self close]; return; }
      [self.session addInput:input]; AVCaptureMetadataOutput *output = [AVCaptureMetadataOutput new];
      if (![self.session canAddOutput:output]) { [self close]; return; }
      [self.session addOutput:output]; output.metadataObjectTypes = @[AVMetadataObjectTypeQRCode];
      [output setMetadataObjectsDelegate:self queue:dispatch_get_main_queue()];
      self.preview = [AVCaptureVideoPreviewLayer layerWithSession:self.session]; self.preview.videoGravity = AVLayerVideoGravityResizeAspectFill;
      [self.view.layer insertSublayer:self.preview atIndex:0]; self.preview.frame = self.view.bounds;
      dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED,0), ^{ if (!self.finished) [self.session startRunning]; });
    });
  }];
}
- (void)viewDidLayoutSubviews { [super viewDidLayoutSubviews]; self.preview.frame = self.view.bounds; }
- (void)viewDidDisappear:(BOOL)animated { [super viewDidDisappear:animated]; self.finished = YES; [self stop]; }
- (void)stop { AVCaptureSession *session = self.session; dispatch_async(dispatch_get_global_queue(QOS_CLASS_UTILITY,0), ^{ [session stopRunning]; }); }
- (void)close { self.finished = YES; [self stop]; [self dismissViewControllerAnimated:YES completion:nil]; }
- (void)captureOutput:(AVCaptureOutput *)output didOutputMetadataObjects:(NSArray *)objects fromConnection:(AVCaptureConnection *)connection {
  for (AVMetadataMachineReadableCodeObject *item in objects) {
    NSString *value = item.stringValue;
    if (self.finished || ![value hasPrefix:@"tailcat://connect/"]) continue;
    self.finished = YES; [self stop];
    [self dismissViewControllerAnimated:YES completion:^{ if (self.completion) self.completion(value); }]; return;
  }
}
@end
void GBPresentNetworkScanner(UIViewController *presenter, void (^completion)(NSString *)) {
  GBNetworkScanner *scanner = [GBNetworkScanner new]; scanner.completion = completion;
  [presenter presentViewController:[[UINavigationController alloc] initWithRootViewController:scanner] animated:YES completion:nil];
}

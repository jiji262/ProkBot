#import "GBNetwork.h"
#import "GBLocalize.h"
#import "GBDiagnostics.h"
#import <Security/Security.h>
#import <sys/socket.h>
#import <netinet/in.h>
#import <unistd.h>

extern char *GBTailcatIdentity(void);
extern char *GBTailcatStart(const char *config);
extern char *GBTailcatStatus(int handle);
extern void GBTailcatStop(int handle);
extern void GBTailcatFree(char *text);

static int GBActiveTunnel, GBPendingTunnel, GBReservedSocket = -1;
static uint16_t GBActivePort, GBPendingPort;
static CFAbsoluteTime GBLastAttempt;
static CFAbsoluteTime GBPeerUnhealthySince;
static const CFTimeInterval GBPeerRecoveryGrace = 20;
static const CFTimeInterval GBPeerInitialGrace = 45;
static BOOL GBPeerWasReady;
static unsigned GBStartFailures;
static NSDictionary *GBActiveNetwork, *GBPendingNetwork;
static char GBNetworkQueueKey;
static dispatch_queue_t GBNetworkQueue(void) {
  static dispatch_queue_t queue;
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    queue = dispatch_queue_create("dev.grokbot.network", DISPATCH_QUEUE_SERIAL);
    dispatch_queue_set_specific(queue, &GBNetworkQueueKey, &GBNetworkQueueKey, NULL);
  });
  return queue;
}
static void GBNetworkSync(dispatch_block_t block) {
  if (dispatch_get_specific(&GBNetworkQueueKey)) block();
  else dispatch_sync(GBNetworkQueue(), block);
}
static void GBNetworkReleaseSocket(void) {
  if (GBReservedSocket >= 0) close(GBReservedSocket);
  GBReservedSocket = -1;
}
static uint16_t GBNetworkPort(NSString *value) {
  if (![value isKindOfClass:NSString.class]) return 0;
  NSURLComponents *url = [NSURLComponents componentsWithString:value];
  NSInteger port = url.port.integerValue;
  return [url.host isEqual:@"127.0.0.1"] && port > 0 && port <= UINT16_MAX ? (uint16_t)port : 0;
}
static void GBNetworkDropPending(void) {
  if (GBPendingTunnel) GBTailcatStop(GBPendingTunnel);
  GBPendingTunnel = 0; GBPendingPort = 0; GBPendingNetwork = nil;
}
static NSDictionary *GBNetworkQuery(void) {
  return @{(__bridge id)kSecClass:(__bridge id)kSecClassGenericPassword,
    (__bridge id)kSecAttrService:[@"grokbot.network." stringByAppendingString:NSBundle.mainBundle.bundleIdentifier],
    (__bridge id)kSecAttrAccount:@"tailcat"};
}
static NSDictionary *GBNetworkRead(void) {
  NSMutableDictionary *query = [GBNetworkQuery() mutableCopy]; query[(__bridge id)kSecReturnData] = @YES;
  CFTypeRef data = NULL;
  if (SecItemCopyMatching((__bridge CFDictionaryRef)query, &data) != errSecSuccess) return nil;
  id value = [NSJSONSerialization JSONObjectWithData:CFBridgingRelease(data) options:0 error:nil];
  return [value isKindOfClass:NSDictionary.class] ? value : nil;
}
static BOOL GBNetworkWrite(NSDictionary *value) {
  NSDictionary *attrs = @{(__bridge id)kSecValueData:[NSJSONSerialization dataWithJSONObject:value options:0 error:nil],
    (__bridge id)kSecAttrAccessible:(__bridge id)kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly};
  OSStatus result = SecItemUpdate((__bridge CFDictionaryRef)GBNetworkQuery(), (__bridge CFDictionaryRef)attrs);
  if (result == errSecItemNotFound) { NSMutableDictionary *q = [GBNetworkQuery() mutableCopy]; [q addEntriesFromDictionary:attrs]; result = SecItemAdd((__bridge CFDictionaryRef)q, NULL); }
  return result == errSecSuccess;
}
static NSDictionary *GBNetworkResult(char *raw) {
  if (!raw) return nil;
  NSData *data = [[NSString stringWithUTF8String:raw] dataUsingEncoding:NSUTF8StringEncoding]; GBTailcatFree(raw);
  id result = [NSJSONSerialization JSONObjectWithData:data options:0 error:nil];
  return [result isKindOfClass:NSDictionary.class] ? result : nil;
}
NSString *GBNetworkAddress(void) {
  __block NSString *address; GBNetworkSync(^{ address = GBActiveNetwork[@"address"] ?: @""; }); return address;
}
BOOL GBNetworkEnabled(void) {
  __block BOOL enabled; GBNetworkSync(^{ enabled = [GBActiveNetwork[@"enabled"] boolValue]; }); return enabled;
}
BOOL GBNetworkEnsureReadyForURL(NSURL *url) {
  __block BOOL ready = YES;
  GBNetworkSync(^{
    if (![GBActiveNetwork[@"enabled"] boolValue] || ![url.host isEqual:@"127.0.0.1"] ||
        url.port.integerValue != GBActivePort) return;
    NSDictionary *status = GBActiveTunnel ? GBNetworkResult(GBTailcatStatus(GBActiveTunnel)) : nil;
    CFAbsoluteTime now = CFAbsoluteTimeGetCurrent();
    BOOL listening = [status[@"listening"] boolValue];
    if (listening) {
      if ([status[@"state"] isEqual:@"ready"] && ![status[@"error"] length]) {
        GBPeerUnhealthySince = 0; GBPeerWasReady = YES;
        return;
      }
      // Keep short outages and initial handshakes on the existing client. A
      // suspended client can retain its listener while its peer stack is stale.
      if (!GBPeerUnhealthySince || now < GBPeerUnhealthySince) GBPeerUnhealthySince = now;
      CFTimeInterval grace = GBPeerWasReady ? GBPeerRecoveryGrace : GBPeerInitialGrace;
      if (now - GBPeerUnhealthySince < grace) return;
    }
    ready = NO;
    double backoff = MIN(10.0, 0.5 * (1u << MIN(GBStartFailures, 4u)));
    if (GBStartFailures && now >= GBLastAttempt && now - GBLastAttempt < backoff) return;
    GBLastAttempt = now;
    int old = GBActiveTunnel; GBActiveTunnel = 0;
    if (old) GBTailcatStop(old); // Releases the local listener before asynchronous peer cleanup.
    GBNetworkReleaseSocket();
    NSDictionary *config = @{@"mode":@"forward", @"link":GBActiveNetwork[@"address"],
      @"identity":GBActiveNetwork[@"identity"], @"localPort":@(GBActivePort)};
    NSData *data = [NSJSONSerialization dataWithJSONObject:config options:0 error:nil];
    NSString *raw = [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding];
    NSDictionary *result = GBNetworkResult(GBTailcatStart(raw.UTF8String));
    int handle = [result[@"handle"] intValue];
    ready = handle && [result[@"status"][@"listening"] boolValue] &&
      GBNetworkPort(result[@"status"][@"localURL"]) == GBActivePort;
    if (ready) { GBActiveTunnel = handle; GBStartFailures = 0; GBPeerUnhealthySince = now; }
    else { if (handle) GBTailcatStop(handle); GBStartFailures = MIN(GBStartFailures + 1, 8u); }
    GBDiagnosticsEvent(old ? @"connection.tunnel.restart" : @"connection.tunnel.start",
      @{@"port":@(GBActivePort), @"success":@(ready),
        @"reason":listening ? @"peer-unreachable" : @"listener-unavailable"});
  });
  return ready;
}
NSDictionary *GBNetworkStatus(void) {
  __block NSDictionary *status;
  GBNetworkSync(^{
    if (![GBActiveNetwork[@"enabled"] boolValue]) { status = @{@"state":@"direct", @"healthy":@YES}; return; }
    NSDictionary *value = GBActiveTunnel ? GBNetworkResult(GBTailcatStatus(GBActiveTunnel)) : nil;
    NSMutableDictionary *result = [(value ?: @{@"state":@"connecting"}) mutableCopy];
    result[@"healthy"] = @([value[@"listening"] boolValue] && [value[@"state"] isEqual:@"ready"] &&
      ![value[@"error"] length]);
    status = result;
  });
  return status;
}
void GBNetworkRollback(void) { GBNetworkSync(^{ GBNetworkDropPending(); }); }
NSString *GBNetworkPrepare(NSString *address, BOOL enabled, NSError **error) {
  __block NSString *prepared;
  GBNetworkSync(^{
    GBNetworkDropPending();
    NSString *input = [address stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet];
    NSMutableDictionary *record = [@{@"address":input ?: @"", @"enabled":@(enabled)} mutableCopy];
    if (!enabled) {
      NSURLComponents *url = [NSURLComponents componentsWithString:input];
      if (!([url.scheme isEqual:@"http"] || [url.scheme isEqual:@"https"]) || !url.host.length ||
          url.user || url.password || url.query || url.fragment || (url.path.length && ![url.path isEqual:@"/"])) return;
      url.path = @""; record[@"address"] = url.URL.absoluteString;
      GBPendingNetwork = record; prepared = record[@"address"]; return;
    }
    // Editing tests a separate tunnel while the active connection is still usable.
    NSDictionary *identity = GBActiveTunnel ? GBNetworkResult(GBTailcatIdentity())
      : (GBActiveNetwork[@"identity"] ?: GBNetworkRead()[@"identity"] ?: GBNetworkResult(GBTailcatIdentity()));
    if (!identity) return;
    record[@"identity"] = identity;
    NSDictionary *config = @{@"mode":@"forward", @"link":input ?: @"", @"identity":identity};
    NSString *raw = [[NSString alloc] initWithData:[NSJSONSerialization dataWithJSONObject:config options:0 error:nil] encoding:NSUTF8StringEncoding];
    NSDictionary *result = GBNetworkResult(GBTailcatStart(raw.UTF8String));
    int handle = [result[@"handle"] intValue];
    uint16_t port = GBNetworkPort(result[@"status"][@"localURL"]);
    if (!handle || !port || ![result[@"status"][@"listening"] boolValue]) { if (handle) GBTailcatStop(handle); return; }
    GBPendingTunnel = handle; GBPendingPort = port; GBPendingNetwork = record;
    prepared = result[@"status"][@"localURL"];
  });
  if (!prepared && error) *error = [NSError errorWithDomain:@"GrokBotNetwork" code:1
    userInfo:@{NSLocalizedDescriptionKey:GBL(@"无法连接，请检查地址后重试。", @"Could not connect. Check the address and try again.")}];
  return prepared;
}
BOOL GBNetworkCommit(void) {
  __block BOOL committed = NO;
  GBNetworkSync(^{
    if (!GBPendingNetwork || !GBNetworkWrite(GBPendingNetwork)) return;
    int old = GBActiveTunnel;
    GBNetworkReleaseSocket();
    GBActiveTunnel = GBPendingTunnel; GBActivePort = GBPendingPort; GBActiveNetwork = GBPendingNetwork;
    GBPendingTunnel = 0; GBPendingPort = 0; GBPendingNetwork = nil;
    GBLastAttempt = 0; GBStartFailures = 0; GBPeerUnhealthySince = 0; GBPeerWasReady = NO;
    if (old) GBTailcatStop(old);
    committed = YES;
  });
  return committed;
}
NSString *GBNetworkRestore(NSString *fallback) {
  __block NSString *address;
  GBNetworkSync(^{
    if (GBActiveTunnel || GBReservedSocket >= 0) {
      address = [NSString stringWithFormat:@"http://127.0.0.1:%hu", GBActivePort]; return;
    }
    GBActiveNetwork = GBNetworkRead();
    if (![GBActiveNetwork[@"enabled"] boolValue]) { address = GBActiveNetwork[@"address"] ?: fallback; return; }
    // Constructor restore never enters Go. Hold the port until the first request
    // starts the listener after dyld has completed its initializers.
    GBNetworkReleaseSocket();
    int fd = socket(AF_INET, SOCK_STREAM, 0);
    struct sockaddr_in local = {0}; local.sin_family = AF_INET; local.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    if (fd < 0 || bind(fd, (struct sockaddr *)&local, sizeof(local)) != 0) { if (fd >= 0) close(fd); return; }
    socklen_t size = sizeof(local);
    if (getsockname(fd, (struct sockaddr *)&local, &size) != 0) { close(fd); return; }
    GBReservedSocket = fd; GBActivePort = ntohs(local.sin_port);
    GBActiveTunnel = 0; GBLastAttempt = 0; GBStartFailures = 0; GBPeerUnhealthySince = 0; GBPeerWasReady = NO;
    address = [NSString stringWithFormat:@"http://127.0.0.1:%hu", GBActivePort];
  });
  return address;
}
void GBNetworkClear(void) {
  GBNetworkSync(^{
    GBNetworkDropPending();
    int old = GBActiveTunnel;
    GBActiveTunnel = 0; GBActivePort = 0; GBActiveNetwork = nil;
    GBLastAttempt = 0; GBStartFailures = 0; GBPeerUnhealthySince = 0; GBPeerWasReady = NO;
    GBNetworkReleaseSocket();
    SecItemDelete((__bridge CFDictionaryRef)GBNetworkQuery());
    if (old) GBTailcatStop(old);
  });
}

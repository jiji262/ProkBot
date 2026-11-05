#import <Foundation/Foundation.h>
FOUNDATION_EXPORT void GBDiagnosticsRecordBundle(NSURL *requested, NSURL *loaded);
FOUNDATION_EXPORT void GBDiagnosticsEvent(NSString *event, NSDictionary *values);
FOUNDATION_EXPORT void GBDiagnosticsObserveTask(NSURLSessionTask *task);

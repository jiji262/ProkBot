#import <Foundation/Foundation.h>
// Local authenticated requests never follow redirects or retain HTTP cookies.
NSURLSession *GBHTTPSession(void);

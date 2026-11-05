import { proxyHttp } from "./proxy.mjs";
import { check } from "./security.mjs";

const routes = new Map([
  ["/local-exec/requests", "GET"],
  ["/local-exec/responses", "POST"],
]);

/** The desktop main process provides execution; browser pages cannot register. */
export function proxyLocalExec(request, response, path, options) {
  const method = routes.get(path);
  if (!method) return false;
  check(request.headers.origin === undefined, 403, "本机执行器不接受浏览器请求");
  check(request.method === method, 405, "本机执行器请求方法不正确");
  const device = options.authenticate(request);
  check(device.platform === "desktop", 403, "只有配对的桌面客户端可以提供本机执行");
  check(options.internalToken, 503, "Host 尚未启用本机执行认证");
  options.connections.track(device.id, response);
  proxyHttp(request, response, {
    target: options.hostUrl,
    path,
    token: options.internalToken,
  });
  return true;
}

import http from 'node:http';
import https from 'node:https';
import http2 from 'node:http2';
import { syncBuiltinESMExports } from 'node:module';

/** Host background services may reach only local endpoints and the configured model. */
export function installHostNetworkBoundary(modelBaseUrl, { additionalHosts = [] } = {}) {
  const modelHost = new URL(modelBaseUrl).hostname;
  const allowedHosts = new Set(['127.0.0.1', 'localhost', '::1', '[::1]', modelHost, ...additionalHosts]);
  const assertAllowed = input => {
    const url = typeof input === 'string' || input instanceof URL ? new URL(input)
      : input instanceof Request ? new URL(input.url) : null;
    const hostname = url?.hostname ?? input?.hostname ?? input?.host?.split(':')[0];
    if (hostname && allowedHosts.has(hostname)) return;
    const error = new Error(`Host network capability unavailable: ${hostname ?? 'unknown host'}`);
    error.code = 'LOCAL_CAPABILITY_UNAVAILABLE';
    throw error;
  };
  const fetch = globalThis.fetch;
  globalThis.fetch = async (input, options) => {
    assertAllowed(input);
    return fetch(input, options);
  };
  for (const transport of [http, https]) {
    const request = transport.request;
    transport.request = function (input, ...args) {
      assertAllowed(input);
      return request.call(this, input, ...args);
    };
    transport.get = function (input, ...args) {
      const request = transport.request(input, ...args);
      request.end();
      return request;
    };
  }
  const connect = http2.connect;
  http2.connect = function (authority, ...args) {
    assertAllowed(authority);
    return connect.call(this, authority, ...args);
  };
  syncBuiltinESMExports();
}

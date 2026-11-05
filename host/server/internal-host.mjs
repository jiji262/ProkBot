import { HttpError } from './security.mjs';
export function internalHostClient(url, token) {
  return async (method, args, { signal } = {}) => {
    if (!/^[A-Za-z][A-Za-z0-9]+$/.test(method)) throw new Error('Invalid Host method');
    const response = await fetch(new URL(`/api/${method}`, url), { method: 'POST', redirect: 'error',
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(args), signal: signal ?? AbortSignal.timeout(method === 'localApplicationRpc' ? 110000 : 30000) });
    const result = await response.json();
    if (!response.ok) throw new HttpError(response.status, result.error ?? 'Host request failed');
    return result;
  };
}

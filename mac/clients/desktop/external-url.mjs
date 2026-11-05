export function externalHttpUrl(value) {
  if (typeof value !== 'string' || value.length > 16384 || /[\u0000-\u001f\u007f]/.test(value)) return null;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (url.username || url.password) return null;
    return url.toString();
  } catch {
    return null;
  }
}

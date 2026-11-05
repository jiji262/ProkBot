// The original language picker reloads the renderer after saving its setting.
// Preload supplies that resolved setting before any patched component renders.
let getLocale = null;
export function setLocaleSource(source) { getLocale = source; }
export function grokText(zh, en) {
  const locale = globalThis.window?.localBot?.locale ?? globalThis.window?.connection?.locale ?? getLocale?.() ?? globalThis.navigator?.language ?? 'en';
  return /^zh\b/i.test(locale) ? zh : en;
}

import { $, } from './ui.js';
import { t, locale } from './i18n.js';

export function createVoiceEditor({ api, toast, busy }) {
  const form = $('#voice-form'), fields = form.elements, button = form.querySelector('[type=submit]');
  const error = $('#voice-error'), preview = $('#voice-preview'), player = $('#voice-audio');
  let loaded = false, saved, audioUrl, controller, dirty = false, catalogPage = 0;
  const library = $('#voice-library'), libraryLoad = $('#voice-library-load'), libraryNext = $('#voice-library-next');
  $('#voice-library-language').value = locale.startsWith('zh') ? 'zh' : 'en';
  $('#voice-preview-text').value = t('你好，我们可以开始语音聊天了。');
  function errorText(value) {
    const messages = {
      'Voice chat is not configured': '请启用语音通话', 'Voice endpoint is required': '请输入接口地址',
      'Fish Audio API key is required': '请输入 Fish Audio API Key',
      'Choose a Fish voice or enter a reference ID': '请选择音色或填写音色 ID',
      'Could not load voice library': '无法读取音色，可手动填写音色 ID',
      'A Fish speech key with the same service origin is required': '请先保存同服务的 Fish 识别密钥',
      'Voice model is required': '请输入语音模型', 'Voice is required': '请输入音色',
      'Voice service API credit is insufficient': '语音服务额度不足',
      'Voice service rejected the API key': '语音服务拒绝了 API Key',
      'Voice synthesis timed out': '语音合成超时', 'Could not reach the voice service': '无法连接语音服务',
    };
    return t(messages[value] ?? value);
  }
  function controls() {
    const fish = fields.provider.value === 'fish';
    $('#voice-reference-row').hidden = !fish; $('#voice-name-row').hidden = fish;
    $('#voice-library-row').hidden = !fish;
    fields.referenceId.required = fish && fields.enabled.checked;
    $('#voice-reuse-row').hidden = !fish;
    $('#voice-key-row').hidden = fish && fields.reuseKey.checked;
    $('#voice-clear-row').hidden = $('#voice-key-row').hidden || !saved?.tts.hasApiKey;
    preview.disabled = !loaded || !saved?.enabled || dirty;
    button.disabled = !loaded;
  }
  function render(value) {
    saved = value; loaded = true; dirty = false; form.reset();
    $('#voice-preview-text').value = t('你好，我们可以开始语音聊天了。');
    fields.enabled.checked = value.enabled;
    for (const name of ['provider', 'endpoint', 'model', 'referenceId', 'voice', 'speed']) fields[name].value = value.tts[name];
    fields.reuseKey.checked = value.tts.apiKeySource === 'speech';
    fields.apiKey.placeholder = t(value.tts.hasApiKey ? '已保存，留空保留' : '输入 API Key');
    $('#voice-asr-status').textContent = value.asr.configured ? t('使用上方识别服务') : t('请先启用识别服务');
    error.hidden = true; controls();
  }
  function clearAudio() { player.pause(); player.removeAttribute('src'); player.hidden = true; if (audioUrl) URL.revokeObjectURL(audioUrl); audioUrl = null; }
  async function load() {
    if (loaded) return;
    try { render(await api('/admin/api/voice')); }
    catch (e) { error.textContent = errorText(e.message); error.hidden = false; }
  }
  fields.provider.addEventListener('change', () => {
    fields.endpoint.value = fields.provider.value === 'fish' ? 'https://api.fish.audio/v1/tts' : '';
    fields.model.value = ''; fields.voice.value = ''; fields.referenceId.value = ''; fields.apiKey.value = '';
    fields.reuseKey.checked = false; controls();
  });
  fields.reuseKey.addEventListener('change', controls);
  const dirtyInput = event => { if (!['voice-preview-text', 'voice-library-search', 'voice-library-language', 'voice-library'].includes(event.target.id)) { dirty = true; controls(); } };
  form.addEventListener('input', dirtyInput);
  form.addEventListener('change', dirtyInput);
  async function loadVoices(page) {
    error.hidden = true;
    try {
      const data = await api('/admin/api/voice/voices', { method: 'POST', body: {
        page, language: $('#voice-library-language').value, title: $('#voice-library-search').value.trim(),
        tts: { endpoint: fields.endpoint.value.trim(), apiKey: fields.apiKey.value.trim(),
          apiKeySource: fields.reuseKey.checked ? 'speech' : 'own', clearApiKey: fields.clearApiKey.checked },
      } });
      catalogPage = data.page;
      library.replaceChildren(new Option(t('选择音色'), ''), ...data.voices.map(voice => new Option(voice.name, voice.id)));
      library.value = fields.referenceId.value;
      $('#voice-library-results').hidden = false; libraryNext.hidden = !data.hasMore;
    } catch (e) { error.textContent = errorText(e.message); error.hidden = false; }
  }
  libraryLoad.addEventListener('click', () => void busy(libraryLoad, () => loadVoices(1)));
  libraryNext.addEventListener('click', () => void busy(libraryNext, () => loadVoices(catalogPage + 1)));
  library.addEventListener('change', () => {
    if (!library.value) return;
    fields.referenceId.value = library.value; dirty = true; controls();
  });
  form.addEventListener('submit', event => {
    event.preventDefault();
    void busy(button, async () => {
      try {
        const tts = Object.fromEntries(['provider', 'endpoint', 'model', 'referenceId', 'voice', 'apiKey'].map(name => [name, fields[name].value.trim()]));
        Object.assign(tts, { speed: Number(fields.speed.value), apiKeySource: fields.provider.value === 'fish' && fields.reuseKey.checked ? 'speech' : 'own', clearApiKey: fields.clearApiKey.checked });
        render(await api('/admin/api/voice', { method: 'PUT', body: { enabled: fields.enabled.checked, tts } }));
        toast(t('配置已保存')); clearAudio();
      } catch (e) { error.textContent = errorText(e.message); error.hidden = false; }
    });
  });
  preview.addEventListener('click', () => void busy(preview, async () => {
    clearAudio(); error.hidden = true; controller?.abort(); controller = new AbortController();
    try {
      const response = await fetch('/admin/api/voice/test', { method: 'POST', credentials: 'same-origin',
        headers: { 'content-type': 'application/json', 'x-grokbot-csrf': '1' }, signal: controller.signal,
        body: JSON.stringify({ text: $('#voice-preview-text').value.trim() }) });
      if (!response.ok) throw new Error((await response.json()).error);
      audioUrl = URL.createObjectURL(await response.blob()); player.src = audioUrl; player.hidden = false;
      await player.play().catch(() => {});
    } catch (e) { if (e.name !== 'AbortError') { error.textContent = errorText(e.message); error.hidden = false; } }
  }));
  return { load, reset() { controller?.abort(); loaded = false; saved = undefined; clearAudio(); form.reset(); controls(); } };
}

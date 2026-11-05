import { t, html, locale } from './i18n.js';
import { $ } from './ui.js';
import { createVoiceEditor } from './voice.js';

const endpoints = {
  fish: 'https://api.fish.audio/v1/asr',
  openai: 'http://host.docker.internal:8000/v1/audio/transcriptions',
};
const audioTypes = { wav: 'audio/wav', mp3: 'audio/mpeg', m4a: 'audio/mp4', webm: 'audio/webm' };
const speechErrors = {
  'Speech recognition is not configured': '尚未配置语音识别',
  'Speech recognition is busy; try again': '语音识别繁忙，请重试',
  'Speech recognition timed out': '语音识别超时',
  'Speech recognition cancelled': '语音识别已取消',
  'Could not reach the speech service': '无法连接语音服务',
  'Speech service API credit is insufficient': '语音服务 API 额度不足',
  'Speech service rejected the API key': '语音服务 API Key 无效',
  'Speech endpoint is required': '请填写语音接口地址',
  'Fish Audio API key is required': '请填写 Fish Audio API Key',
  'Unsupported audio format': '不支持此录音格式',
  'Could not decode the recording': '无法读取录音，请重试',
  'Audio conversion requires FFmpeg': 'Host 缺少 FFmpeg',
  'Decoded audio exceeds 25 MB': '录音过长，请缩短后重试',
};
const providers = '<option value="fish">Fish Audio</option><option value="openai">OpenAI 兼容</option>';
const row = (title, control, { hint = '', id = '', hidden = false } = {}) =>
  `<label class="row"${id ? ` id="${id}"` : ''}${hidden ? ' hidden' : ''}><span class="row-copy"><span class="row-title">${title}</span>${hint}</span>${control}</label>`;

const markup = `<header class="page-header"><h1>语音</h1></header>
  <form id="speech-form" class="section">
    <div class="section-head"><h2 class="section-title">语音识别</h2></div>
    <div class="card">
      ${row('启用语音识别', '<input name="enabled" type="checkbox" role="switch" />', { hint: '<span class="row-hint">客户端录音转为文字</span>' })}
      ${row('服务', `<select name="provider">${providers}</select>`)}
      ${row('接口地址', '<input name="endpoint" type="url" spellcheck="false" autocomplete="off" data-private required />', { hint: '<span id="speech-endpoint-hint" class="row-hint" hidden>Mac 服务可使用局域网地址</span>' })}
      ${row('API Key', '<input name="apiKey" type="password" autocomplete="new-password" spellcheck="false" data-private />')}
      ${row('清除已保存的 API Key', '<input name="clearApiKey" type="checkbox" />', { id: 'speech-clear-key-row', hidden: true })}
      ${row('模型', '<input name="model" autocomplete="off" spellcheck="false" placeholder="服务端默认" />', { id: 'speech-model-row', hidden: true })}
      ${row('识别语言', '<input name="language" autocomplete="off" spellcheck="false" maxlength="32" placeholder="自动检测" />', { hint: '<span class="row-hint">语言代码，如 zh 或 en</span>' })}
    </div>
    <p id="speech-error" class="error" role="alert" hidden></p>
    <div class="actions"><span id="speech-state" class="status-text" role="status">正在读取设置…</span><button id="speech-retry" type="button" class="btn" hidden>重试</button><button type="submit" class="btn btn-primary" disabled>保存</button></div>
  </form>
  <section class="section">
    <div class="section-head"><h2 class="section-title">测试识别</h2></div>
    <div class="card">
      <div class="row"><span class="row-copy"><span id="speech-file-name" class="row-title" data-private>尚未选择文件</span><span id="speech-file-hint" class="row-hint">WAV、MP3、M4A 或 WebM</span></span>
        <span class="row-control auto"><button id="speech-choose-file" type="button" class="btn">选择音频</button><button id="speech-test" type="button" class="btn btn-primary" disabled>开始识别</button></span></div>
      <input id="speech-audio-file" type="file" accept=".wav,.mp3,.m4a,.webm,audio/wav,audio/mpeg,audio/mp4,audio/webm" hidden />
      <p id="speech-test-state" class="hint" role="status"></p>
      <p id="speech-test-error" class="error" role="alert" hidden></p>
      <div id="speech-result" class="row stack" hidden><label class="field">识别结果<textarea id="speech-result-text" readonly rows="4" data-private></textarea></label><p id="speech-result-meta" class="hint"></p></div>
    </div>
  </section>
  <form id="voice-form" class="sections">
    <section class="section">
      <div class="section-head"><h2 class="section-title">语音通话</h2></div>
      <div class="card">
        ${row('启用语音通话', '<input name="enabled" type="checkbox" role="switch" />', { hint: '<span class="row-hint">使用当前 Bot 的模型、上下文和工具。</span><span id="voice-asr-status" class="row-hint"></span>' })}
        ${row('合成服务', `<select name="provider">${providers}</select>`)}
        ${row('接口地址', '<input name="endpoint" type="url" required autocomplete="off" spellcheck="false" data-private />')}
        ${row('使用识别服务的 API Key', '<input name="reuseKey" type="checkbox" role="switch" />', { id: 'voice-reuse-row' })}
        ${row('API Key', '<input name="apiKey" type="password" autocomplete="new-password" spellcheck="false" data-private />', { id: 'voice-key-row' })}
        ${row('清除已保存的 API Key', '<input name="clearApiKey" type="checkbox" />', { id: 'voice-clear-row', hidden: true })}
        ${row('语音模型', '<input name="model" autocomplete="off" spellcheck="false" placeholder="服务端默认" />')}
        ${row('语速', '<select name="speed"><option value="0.75">0.75×</option><option value="1">1×</option><option value="1.25">1.25×</option><option value="1.5">1.5×</option></select>')}
      </div>
    </section>
    <section class="section">
      <div class="section-head"><h2 class="section-title">音色</h2></div>
      <div class="card">
        <div id="voice-library-row">
          <div class="row"><input id="voice-library-search" class="grow" maxlength="100" autocomplete="off" aria-label="查找音色" placeholder="查找音色" />
            <span class="row-control auto"><select id="voice-library-language" aria-label="语言"><option value="zh">简体中文</option><option value="en">English</option></select><button id="voice-library-load" type="button" class="btn">读取音色</button></span></div>
          <div id="voice-library-results" class="row" hidden><select id="voice-library" class="grow" aria-label="公开音色"><option value="">选择音色</option></select><button id="voice-library-next" type="button" class="btn" hidden>下一页</button></div>
        </div>
        ${row('音色 ID', '<input name="referenceId" autocomplete="off" spellcheck="false" placeholder="选择音色或填写 ID" />', { id: 'voice-reference-row' })}
        ${row('音色', '<input name="voice" autocomplete="off" spellcheck="false" />', { id: 'voice-name-row', hidden: true })}
      </div>
      <p id="voice-error" class="error" role="alert" hidden></p>
      <div class="actions"><button type="submit" class="btn btn-primary" disabled>保存</button></div>
    </section>
    <section class="section">
      <div class="section-head"><h2 class="section-title">试听</h2></div>
      <div class="card">
        <div class="row"><input id="voice-preview-text" class="grow" maxlength="300" aria-label="试听文字" /><button id="voice-preview" type="button" class="btn" disabled>试听</button></div>
        <audio id="voice-audio" class="voice-audio" controls hidden></audio>
      </div>
    </section>
  </form>`;

export function createSpeechPage(context) {
  $('[data-panel=speech]').innerHTML = html(markup);
  const speech = createSpeechEditor(context), voice = createVoiceEditor(context);
  return {
    async load() { await Promise.all([speech.load(), voice.load()]); },
    reset() { speech.reset(); voice.reset(); },
  };
}

function createSpeechEditor({ api, toast, busy }) {
  const form = $('#speech-form'), fields = form.elements;
  const save = form.querySelector('[type="submit"]'), test = $('#speech-test'), picker = $('#speech-audio-file');
  let config = null, dirty = false, loading = false, testing = false, version = 0;

  function failure(selector, error) {
    const code = /^Speech service returned HTTP (\d+)$/.exec(error.message);
    $(selector).textContent = code ? t('语音服务返回 HTTP {0}', code[1]) : t(speechErrors[error.message] || error.message);
    $(selector).hidden = false;
  }
  function providerFields() {
    const openai = fields.provider.value === 'openai';
    $('#speech-model-row').hidden = !openai;
    $('#speech-endpoint-hint').hidden = !openai;
    fields.endpoint.placeholder = endpoints[fields.provider.value];
  }
  function keyState() {
    const retained = config?.hasApiKey && fields.provider.value === config.provider && fields.endpoint.value.trim() === config.endpoint;
    fields.apiKey.placeholder = t(retained ? '已保存，留空保留' : '输入 API Key');
    $('#speech-clear-key-row').hidden = !retained;
    if (!retained) fields.clearApiKey.checked = false;
    fields.apiKey.required = fields.enabled.checked && fields.provider.value === 'fish' && (!retained || fields.clearApiKey.checked);
  }
  function updateTest() {
    test.disabled = testing || !config?.enabled || dirty || !picker.files[0];
    $('#speech-test-state').textContent = testing ? t('正在识别…') : dirty ? t('保存配置后测试') : config && !config.enabled ? t('启用并保存后测试') : '';
    $('#speech-test-state').hidden = !$('#speech-test-state').textContent;
  }
  function changed() {
    dirty = true; save.disabled = false;
    $('#speech-state').textContent = t('有未保存的修改');
    $('#speech-error').hidden = true;
    keyState(); updateTest();
  }
  function render(value) {
    config = value;
    fields.enabled.checked = value.enabled;
    fields.provider.value = value.provider || 'fish';
    fields.endpoint.value = value.endpoint || endpoints[fields.provider.value];
    fields.apiKey.value = '';
    fields.model.value = value.model || '';
    fields.language.value = value.language || '';
    fields.clearApiKey.checked = false;
    $('#speech-file-hint').textContent = t('WAV、MP3、M4A 或 WebM · 最大 {0} MiB',
      new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format((value.maxAudioBytes || 25 * 1024 * 1024) / 1024 / 1024));
    $('#speech-state').textContent = t(value.enabled ? '已启用' : '已停用');
    $('#speech-error').hidden = $('#speech-retry').hidden = true;
    save.disabled = true; dirty = false;
    providerFields(); keyState(); updateTest();
  }
  async function load() {
    if (loading || dirty || config) return;
    loading = true;
    const current = version;
    $('#speech-state').textContent = t('正在读取设置…');
    $('#speech-retry').hidden = true;
    try {
      const value = await api('/admin/api/speech');
      if (current === version) render(value);
    } catch (error) {
      if (current !== version) return;
      failure('#speech-error', error);
      $('#speech-state').textContent = '';
      $('#speech-retry').hidden = false;
    } finally { if (current === version) loading = false; }
  }
  fields.provider.addEventListener('change', () => {
    if (!fields.endpoint.value || Object.values(endpoints).includes(fields.endpoint.value)) fields.endpoint.value = endpoints[fields.provider.value];
    providerFields();
  });
  form.addEventListener('input', changed);
  form.addEventListener('change', changed);
  $('#speech-retry').addEventListener('click', () => { dirty = false; load(); });
  form.addEventListener('submit', event => {
    event.preventDefault();
    $('#speech-error').hidden = true;
    const current = version;
    busy(save, async () => {
      try {
        const body = {
          enabled: fields.enabled.checked, provider: fields.provider.value,
          endpoint: fields.endpoint.value.trim(), language: fields.language.value.trim(),
          model: fields.provider.value === 'openai' ? fields.model.value.trim() : '',
          ...(fields.apiKey.value.trim() ? { apiKey: fields.apiKey.value.trim() } : {}),
          ...(fields.clearApiKey.checked ? { clearApiKey: true } : {}),
        };
        await api('/admin/api/speech', { method: 'PUT', body });
        const value = await api('/admin/api/speech');
        if (current !== version) return;
        render(value);
        toast(t('语音识别配置已保存'));
      } catch (error) { if (current === version) failure('#speech-error', error); }
    }).then(() => { save.disabled = !dirty; });
  });
  $('#speech-choose-file').addEventListener('click', () => picker.click());
  picker.addEventListener('change', () => {
    $('#speech-test-error').hidden = $('#speech-result').hidden = true;
    $('#speech-file-name').textContent = picker.files[0]?.name || t('尚未选择文件');
    updateTest();
  });
  test.addEventListener('click', async () => {
    if (test.disabled) return;
    const current = version, file = picker.files[0];
    testing = true; updateTest();
    $('#speech-test-error').hidden = $('#speech-result').hidden = true;
    $('#speech-choose-file').disabled = true;
    try {
      const mimeType = audioTypes[file.name.split('.').at(-1).toLowerCase()];
      if (!mimeType) throw new Error(t('请选择 WAV、MP3、M4A 或 WebM 音频'));
      if (!file.size) throw new Error(t('音频文件为空'));
      if (file.size > (config.maxAudioBytes || 25 * 1024 * 1024)) throw new Error(t('音频超过大小限制'));
      const audioBase64 = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).split(',')[1]);
        reader.onerror = () => reject(new Error(t('音频读取失败，请重新选择')));
        reader.readAsDataURL(file);
      });
      if (current !== version) return;
      const value = await api('/admin/api/speech/test', { method: 'POST', body: { audioBase64, mimeType } });
      if (current !== version) return;
      $('#speech-result-text').value = value.text || t('未识别到语音');
      const seconds = new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(value.transcriptionTimeMs / 1000);
      $('#speech-result-meta').textContent = `${value.provider === 'fish' ? 'Fish Audio' : t('OpenAI 兼容')} · ${t('{0} 秒', seconds)}`;
      $('#speech-result').hidden = false;
    } catch (error) {
      if (current === version) failure('#speech-test-error', error);
    } finally {
      if (current === version) { testing = false; $('#speech-choose-file').disabled = false; updateTest(); }
    }
  });
  return {
    load,
    reset() {
      version++; config = null; dirty = loading = testing = false;
      form.reset(); picker.value = '';
      $('#speech-result-text').value = '';
      $('#speech-result').hidden = $('#speech-error').hidden = $('#speech-test-error').hidden = true;
      $('#speech-file-name').textContent = t('尚未选择文件');
      $('#speech-choose-file').disabled = false; save.disabled = true;
      providerFields(); keyState(); updateTest();
    },
  };
}

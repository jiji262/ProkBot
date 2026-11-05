import { $, node, date, badge, empty } from './ui.js';
import { t } from './i18n.js';

const tiers = { routine: '一般任务', reasoning: '中等任务', expert: '困难任务' };
const efforts = { none: '无', low: '轻度', medium: '中度', high: '高度', xhigh: '超高', max: '最高', default: '模型默认' };
const sources = { jev: '思考强度由 Jev 选择', rule: '使用规则指定的思考强度', model: '使用模型可用强度' };

export function createRoutingLog({ api }) {
  let pending = false, signature;
  async function load() {
    if (pending) return;
    pending = true;
    const root = $('#routing-log');
    try {
      const { items } = await api('/admin/api/model/routing-log');
      const next = JSON.stringify(items);
      if (signature === next) return;
      signature = next;
      const open = new Set([...root.querySelectorAll('details[open]')].map(row => row.dataset.id));
      if (!items.length) { root.replaceChildren(empty(t('暂无分类记录'))); return; }
      root.replaceChildren(...items.map(item => {
        const entry = node('details', 'disclosure routing-entry'), summary = node('summary'), copy = node('span', 'routing-copy');
        entry.dataset.id = item.id; entry.open = open.has(item.id);
        const headline = node('span', 'routing-headline');
        headline.append(node('strong', '', t(tiers[item.difficulty] ?? item.difficulty)),
          badge(t(item.fallback ? '使用备用规则' : item.source === 'test' ? '测试' : '任务'), item.fallback ? 'warn' : ''),
          node('time', 'hint', date(item.at)));
        copy.append(headline, node('span', 'hint', `${item.model} · ${t(efforts[item.effort] ?? item.effort)}`));
        summary.append(copy); entry.append(summary);
        const body = node('div', 'routing-body'), task = node('p', 'routing-task', item.task);
        task.dataset.private = '';
        body.append(task,
          node('p', 'hint', `${item.classifierModel} · ${item.elapsedMs} ms${Number.isFinite(item.confidence) ? ` · ${t('置信度 {0}', `${Math.round(item.confidence * 100)}%`)}` : ''}`),
          node('p', 'hint', t(sources[item.effortSource] ?? '分类失败，使用中等任务规则')));
        if (item.error) body.append(node('p', 'error', item.error));
        entry.append(body);
        return entry;
      }));
    } catch (error) {
      signature = undefined;
      root.replaceChildren(node('p', 'error', error.message));
    } finally { pending = false; }
  }
  return { load };
}

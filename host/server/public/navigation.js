import { t } from './i18n.js';
import { icon } from './icons.js';
import { node } from './ui.js';

// One source for sidebar order, page titles and icons.
export const groups = [
  { items: [['overview', '概览', 'overview']] },
  { title: '模型服务', items: [['model', '对话模型', 'model'], ['speech', '语音', 'voice'], ['media', '图片与视频', 'image'], ['web-services', '联网工具', 'globe']] },
  { title: 'Agent', items: [['harness', '内置能力', 'toggles'], ['skills', '技能', 'book'], ['apps', '应用', 'plug'], ['prompts', '提示词', 'text']] },
  { title: '设备与网络', items: [['devices', '设备与通知', 'devices'], ['network', '远程访问', 'link'], ['execution', '执行环境', 'monitor']] },
  { title: '协作与集成', items: [['federation', 'Host 协作', 'swap'], ['webhooks', 'Webhook', 'bolt'], ['sharing', '分享', 'share']] },
];

export const titles = Object.fromEntries([...groups.flatMap(group => group.items), ['general', '通用']]
  .map(([view, label]) => [view, t(label)]));

export function renderNavigation(root) {
  root.replaceChildren();
  for (const group of groups) {
    if (group.title) root.append(node('p', 'nav-group', t(group.title)));
    for (const [view, label, glyph] of group.items) {
      const button = node('button', 'nav-item');
      button.type = 'button'; button.dataset.view = view;
      button.innerHTML = icon(glyph);
      button.append(node('span', '', t(label)));
      root.append(button);
    }
  }
}

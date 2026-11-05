import { node } from './ui.js';
import { createFace, hueFor, assignMoods } from './face.js';

// Working Bots stand in a row with their names, each with its own expression; Bots beyond the
// first six fold into a "+N" chip so the overview header keeps its height.
const limit = 6;

export function createCrew(root, hostRoot) {
  let signature = '';
  function render(state, bots) {
    const working = bots.filter(bot => bot.isRunning);
    const next = JSON.stringify([state.host.connected, state.host.busy, working]);
    if (next === signature) return;
    signature = next;
    const host = createFace({ label: 'Host' });
    host.dataset.state = !state.host.connected ? 'sleep' : state.host.busy ? 'busy' : '';
    hostRoot.replaceChildren(host);
    const name = bot => bot.name || bot.id;
    const shown = working.slice(0, limit).map(bot => [createFace({ seed: bot.id, hue: hueFor(bot.id), label: name(bot) }), bot]);
    assignMoods(shown.map(([face, bot]) => [face, bot.id]));
    const items = shown.map(([face, bot]) => {
      const figure = node('figure', 'crew-bot');
      figure.append(face, node('figcaption', 'crew-name', name(bot)));
      return figure;
    });
    if (working.length > limit) {
      const rest = working.slice(limit).map(name).join('、'), chip = node('span', 'crew-more', `+${working.length - limit}`);
      chip.title = rest; chip.setAttribute('aria-label', rest);
      items.push(chip);
    }
    root.replaceChildren(...items);
  }
  return { render, faces: () => [...hostRoot.querySelectorAll('.face'), ...root.querySelectorAll('.face')] };
}

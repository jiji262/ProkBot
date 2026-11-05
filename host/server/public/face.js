import { node } from './ui.js';

// Grok Bot faces: a shaded blob with two slanted eye slits, tinted with a Sand hue per Bot.
const hues = ['red', 'orange', 'yellow', 'green', 'cyan', 'blue', 'purple', 'magenta', 'brown'];
const hash = value => [...String(value)].reduce((sum, char) => (sum * 31 + char.codePointAt(0)) >>> 0, 7);
const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const between = (low, high) => low + Math.random() * (high - low);

// Working expressions; every working face gets its own, with its own tempo and phase.
export const moods = ['reading', 'typing', 'thinking', 'scanning', 'focused', 'nodding'];

export function createFace({ seed = '', hue = '', label = '' } = {}) {
  const face = node('span', 'face'), eyes = node('span', 'face-eyes');
  eyes.append(node('span', 'face-eye'), node('span', 'face-eye'));
  face.append(eyes);
  if (hue) face.dataset.hue = hue;
  face.style.setProperty('--gaze-speed', `${Math.round(between(150, 380))}ms`);
  if (seed) {
    // Each Bot keeps a slightly different silhouette, like the client's avatars.
    const value = hash(seed), corner = shift => 46 + ((value >>> shift) % 9);
    face.style.setProperty('--shape', `${corner(0)}% ${100 - corner(4)}% ${corner(8)}% ${100 - corner(12)}% / ${corner(16)}% ${corner(20)}% ${100 - corner(24)}% ${100 - corner(28)}%`);
  }
  if (label) { face.setAttribute('role', 'img'); face.setAttribute('aria-label', label); }
  else face.setAttribute('aria-hidden', 'true');
  return face;
}

export const hueFor = seed => hues[hash(seed) % hues.length];

/** Gives each face a different working expression, starting from the one its seed prefers. */
export function assignMoods(entries) {
  const used = new Set();
  for (const [face, seed] of entries) {
    const start = hash(seed) % moods.length;
    const mood = moods.map((_, offset) => moods[(start + offset) % moods.length]).find(value => !used.has(value)) ?? moods[start];
    used.add(mood);
    face.dataset.state = 'busy'; face.dataset.mood = mood;
    face.style.setProperty('--mood-speed', between(.85, 1.25).toFixed(2));
    face.style.setProperty('--mood-delay', `${(-between(0, 4)).toFixed(2)}s`);
  }
}

const measure = face => [face, face.querySelector('.face-eyes').getBoundingClientRect(), face.getBoundingClientRect().width];
function aim([face, box, size], x, y, reach) {
  const dx = x - (box.left + box.width / 2), dy = y - (box.top + box.height / 2);
  const distance = Math.hypot(dx, dy) || 1, limit = size * reach, scale = Math.min(1, distance / (size * 0.6));
  face.style.setProperty('--look-x', `${(dx / distance) * limit * scale}px`);
  face.style.setProperty('--look-y', `${(dy / distance) * limit * scale}px`);
}

/** Moves the eyes toward a point on screen, limited to a fraction of the face size. */
export function lookAt(face, x, y, reach = 0.06) { aim(measure(face), x, y, reach); }

export function resetLook(face) {
  face.style.removeProperty('--look-x');
  face.style.removeProperty('--look-y');
}

/** Blinks open faces at random intervals; returns a stop function. */
export function blink(faces) {
  if (reduced()) return () => {};
  let timer;
  const next = () => {
    timer = setTimeout(() => {
      const open = faces().filter(face => !face.dataset.state);
      const face = open[Math.floor(Math.random() * open.length)];
      if (face) { face.classList.add('blink'); setTimeout(() => face.classList.remove('blink'), 150); }
      next();
    }, 1800 + Math.random() * 3200);
  };
  next();
  return () => clearTimeout(timer);
}

/**
 * Idle faces watch the pointer, each on its own schedule: a face re-aims only when its next
 * glance is due, so several faces turn one after another rather than in lockstep.
 */
export function createGaze(faces, { active, reach = 0.07 }) {
  const due = new WeakMap();
  let pointer = null, lastMove = 0, frame = 0;
  const idle = () => faces().filter(face => !face.dataset.state);
  function tick(now) {
    frame = 0;
    if (!pointer || !active()) return;
    const ready = idle().filter(face => (due.get(face) ?? 0) <= now);
    for (const measured of ready.map(measure)) {
      aim(measured, pointer.x, pointer.y, reach);
      due.set(measured[0], now + between(80, 650));
    }
    if (now - lastMove < 1200) frame = requestAnimationFrame(tick);
  }
  addEventListener('pointermove', event => {
    if (!active()) return;
    pointer = { x: event.clientX, y: event.clientY }; lastMove = performance.now();
    if (!frame) frame = requestAnimationFrame(tick);
  });
  document.documentElement.addEventListener('pointerleave', () => { pointer = null; for (const face of faces()) resetLook(face); });
}

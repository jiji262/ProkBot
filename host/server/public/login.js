import { $ } from './ui.js';
import { createFace, lookAt, resetLook, blink } from './face.js';

// The sign-in face peeks over the bottom edge, follows the pointer and looks away while a password is typed.
export function createLoginStage() {
  const face = createFace();
  face.classList.add('login-face');
  $('#auth-face').append(face);
  const password = $('#auth-password'), form = $('#auth-form'), message = $('#auth-error');
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  // Errors appear in a bubble above the composer only while they apply.
  function say(text = '') {
    form.classList.remove('pending');
    message.textContent = text; message.hidden = !text;
  }
  let stopBlink = () => {}, pointer = null;
  const state = value => { if (value) face.dataset.state = value; else delete face.dataset.state; };
  function follow() {
    if (password.value) { state('closed'); return; }
    state('');
    if (document.activeElement === password) {
      const box = password.getBoundingClientRect();
      lookAt(face, box.left + Math.min(box.width, 24 + password.value.length * 8), box.top + box.height / 2, 0.075);
    } else if (pointer) lookAt(face, pointer.x, pointer.y, 0.075);
    else resetLook(face);
  }
  addEventListener('pointermove', event => {
    if ($('#auth-screen').hidden) return;
    pointer = { x: event.clientX, y: event.clientY };
    if (document.activeElement !== password) follow();
  });
  for (const type of ['focus', 'blur', 'input']) password.addEventListener(type, follow);
  password.addEventListener('input', () => { if (!message.hidden) say(); });
  return {
    show() { say(); stopBlink(); stopBlink = blink(() => [face]); follow(); },
    hide() { stopBlink(); },
    thinking() { form.classList.add('pending'); state('up'); },
    async error(text) {
      say(text);
      state('down');
      if (!reduced) { face.classList.remove('shake'); void face.offsetWidth; face.classList.add('shake'); }
      await new Promise(resolve => setTimeout(resolve, 900));
      face.classList.remove('shake'); follow();
    },
    async success() {
      state('happy');
      await new Promise(resolve => setTimeout(resolve, reduced ? 0 : 420));
    },
  };
}

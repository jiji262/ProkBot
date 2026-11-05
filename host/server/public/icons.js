// Line icons drawn on a 24px grid with 1.6px strokes, matching the Grok Bot settings icons.
const paths = {
  overview: '<rect x="3.5" y="3.5" width="7" height="7" rx="1.8"/><rect x="13.5" y="3.5" width="7" height="7" rx="1.8"/><rect x="3.5" y="13.5" width="7" height="7" rx="1.8"/><rect x="13.5" y="13.5" width="7" height="7" rx="1.8"/>',
  model: '<path d="M11 3.5 12.9 9l5.6 2-5.6 2-1.9 5.5L9.1 13l-5.6-2 5.6-2z"/><path d="m18.5 15.5.6 1.9 1.9.6-1.9.6-.6 1.9-.6-1.9-1.9-.6 1.9-.6z"/>',
  voice: '<path d="M4 10v4M8 7v10M12 4v16M16 8v8M20 10.5v3"/>',
  image: '<rect x="3.5" y="4.5" width="17" height="15" rx="2.5"/><circle cx="9" cy="10" r="1.7"/><path d="m20.5 15.5-4.5-4.5-8.5 8.5"/>',
  globe: '<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.3 2.4 3.4 5.2 3.4 8.5s-1.1 6.1-3.4 8.5c-2.3-2.4-3.4-5.2-3.4-8.5s1.1-6.1 3.4-8.5Z"/>',
  toggles: '<rect x="3.5" y="4.5" width="17" height="6.5" rx="3.25"/><circle cx="16.75" cy="7.75" r="1.6"/><rect x="3.5" y="13" width="17" height="6.5" rx="3.25"/><circle cx="7.25" cy="16.25" r="1.6"/>',
  book: '<path d="M5 18.5V6a2.5 2.5 0 0 1 2.5-2.5h11v13h-11A2.5 2.5 0 0 0 5 19a1.5 1.5 0 0 0 1.5 1.5h12"/><path d="M9 7.5h5.5"/>',
  package: '<path d="m12 3.5 7.5 4.2v8.6L12 20.5l-7.5-4.2V7.7Z"/><path d="M4.5 7.7 12 12l7.5-4.3M12 12v8.5"/>',
  plug: '<path d="M9 3.5v4M15 3.5v4M6.5 7.5h11v3a5.5 5.5 0 0 1-11 0ZM12 16v4.5"/>',
  text: '<path d="M5 6.5h14M5 11.5h14M5 16.5h9"/>',
  devices: '<rect x="3" y="5" width="12.5" height="9.5" rx="1.6"/><path d="M1.5 17.5h15.5"/><rect x="17.5" y="8.5" width="5" height="10" rx="1.3"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.66 0l3-3a4 4 0 0 0-5.66-5.66l-1 1"/><path d="M14 10a4 4 0 0 0-5.66 0l-3 3a4 4 0 0 0 5.66 5.66l1-1"/>',
  monitor: '<rect x="3.5" y="4.5" width="17" height="12" rx="2"/><path d="M8.5 20h7M12 16.5V20"/>',
  swap: '<path d="M4 8.5h15l-3.5-3.5M20 15.5H5L8.5 19"/>',
  pulse: '<path d="M3 12h4l2.5-6 5 12 2.5-6H21"/>',
  bolt: '<path d="M13 3.5 5.5 13.5H12l-1 7 7.5-10H12Z"/>',
  share: '<path d="M12 14.5V4M8 7.5l4-4 4 4"/><path d="M5.5 11.5V18a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2v-6.5"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M12 3.5v2M12 18.5v2M3.5 12h2M18.5 12h2M6 6l1.4 1.4M16.6 16.6 18 18M6 18l1.4-1.4M16.6 7.4 18 6"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  close: '<path d="m6 6 12 12M18 6 6 18"/>',
  copy: '<rect x="8.5" y="8.5" width="11" height="11" rx="2"/><path d="M15.5 8.5V6.5a2 2 0 0 0-2-2h-7a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h2"/>',
  refresh: '<path d="M19.5 7.5V3.5M19.5 7.5h-4M4.5 16.5v4M4.5 16.5h4"/><path d="M19 7.4A8 8 0 0 0 4.2 10M5 16.6A8 8 0 0 0 19.8 14"/>',
  eye: '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z"/><circle cx="12" cy="12" r="3"/>',
  eyeOff: '<path d="m3.5 3.5 17 17M9.9 5.8A9 9 0 0 1 12 5.5c6 0 9.5 6.5 9.5 6.5a17 17 0 0 1-3 3.7M6.6 6.7C4 8.5 2.5 12 2.5 12s3.5 6.5 9.5 6.5c1.6 0 3-.4 4.3-1.1"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/>',
  edit: '<path d="M14.5 5.5 18.5 9.5M4.5 19.5l1-4.5L16 4.5a2.1 2.1 0 0 1 3 3L8.5 18Z"/>',
  qr: '<rect x="4" y="4" width="6" height="6" rx="1"/><rect x="14" y="4" width="6" height="6" rx="1"/><rect x="4" y="14" width="6" height="6" rx="1"/><path d="M14 14h2.5v2.5H14zM17.5 17.5H20V20h-2.5zM14 20h1M20 14v1"/>',
  chevron: '<path d="m9.5 6 6 6-6 6"/>',
  menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
  more: '<circle cx="6" cy="12" r="1.4" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none"/><circle cx="18" cy="12" r="1.4" fill="currentColor" stroke="none"/>',
  external: '<path d="M13.5 4.5h6v6M19.5 4.5l-8 8M18 14v4a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 4 18V7.5A1.5 1.5 0 0 1 5.5 6h4"/>',
};

export function icon(name, size = 16) {
  return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name]}</svg>`;
}


// Monochrome inline icons for the chrome (no colour emoji as UI icons). Stroke
// in currentColor, so each one takes the colour of the text around it.
const svg = (body) => `<svg class="ico" viewBox="0 0 16 16" aria-hidden="true">${body}</svg>`;
const lucide = (name, body) => `<svg class="ico lucide" data-icon="${name}" viewBox="0 0 24 24" aria-hidden="true">${body}</svg>`;
export const ICON = {
  search: svg('<circle cx="6.5" cy="6.5" r="4.5"/><path d="M10 10l4.5 4.5"/>'),
  users: svg('<circle cx="6" cy="5" r="2.5"/><path d="M1.5 13.5c0-2.5 2-4.5 4.5-4.5s4.5 2 4.5 4.5"/><circle cx="11.5" cy="5.5" r="2"/><path d="M11.5 9.5c1.8 0 3 1.6 3 3.5"/>'),
  clip: svg('<path d="M13 7.5l-5.5 5.5a3 3 0 0 1-4.2-4.2l6-6a2 2 0 0 1 2.8 2.8l-6 6a1 1 0 0 1-1.4-1.4L10 4.9"/>'),
  reply: svg('<path d="M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z"/>'),
  pencil: svg('<path d="M11.5 2.5l2 2-8 8-3 1 1-3z"/>'),
  trash: svg('<path d="M3 4.5h10M6.5 4.5v-1.5h3v1.5M4.5 4.5l.7 8.5h5.6l.7-8.5M7 7v4M9 7v4"/>'),
  doc: svg('<path d="M4 1.5h5l3 3v10H4zM9 1.5v3h3M6 8h4M6 10.5h4"/>'),
  megaphone: svg('<path d="M2.5 6.5v3h2.5l5 3v-9l-5 3zM12 5.5a3 3 0 0 1 0 5"/>'),
  chat: svg('<path d="M2 3h12v8H7l-3.5 2.5V11H2z"/>'),
  // Lucide set (24px grid, stroke 2), the message toolbar and expand chevrons (Maya, msgs 32de034e, 8f8ed1a0)
  smilePlus: lucide('smile-plus', '<path d="M22 11v1a10 10 0 1 1-9-10"/><path d="M8 14s1.5 2 4 2 4-2 4-2"/><line x1="9" x2="9.01" y1="9" y2="9"/><line x1="15" x2="15.01" y1="9" y2="9"/><path d="M16 5h6"/><path d="M19 2v6"/>'),
  messageSquare: lucide('message-square', '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>'),
  bookmark: lucide('bookmark', '<path d="m19 21-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16z"/>'),
  moreVertical: lucide('more-vertical', '<circle cx="12" cy="12" r="1"/><circle cx="12" cy="5" r="1"/><circle cx="12" cy="19" r="1"/>'),
  pencilL: lucide('pencil', '<path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/><path d="m15 5 4 4"/>'),
  trash2: lucide('trash-2', '<path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/><line x1="10" x2="10" y1="11" y2="17"/><line x1="14" x2="14" y1="11" y2="17"/>'),
  chevronRight: lucide('chevron-right', '<path d="m9 18 6-6-6-6"/>'),
  chevronDown: lucide('chevron-down', '<path d="m6 9 6 6 6-6"/>'),
  paperclip: lucide('paperclip', '<path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48"/>'),
  arrowUp: lucide('arrow-up', '<path d="m5 12 7-7 7 7"/><path d="M12 19V5"/>'),
};

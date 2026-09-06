// A workspace's mark: its uploaded image, else the initials of its first two
// words on its colour slot. Initials render from data-initials (CSS ::before)
// so the element adds no text to its parent and name checks stay exact.
export const wsInitials = (name) => {
  const words = String(name || '').trim().split(/\s+/).filter(Boolean).slice(0, 2);
  return words.map((w) => w[0].toUpperCase()).join('') || '?';
};

// attachment images sit behind bearer auth: fetch once per url, cache the object url
const blobs = {};
const blobURL = (url, headers) => {
  if (!blobs[url]) {
    blobs[url] = fetch(url, { headers })
      .then((r) => (r.ok ? r.blob() : Promise.reject(new Error('avatar fetch failed'))))
      .then((b) => URL.createObjectURL(b))
      .catch(() => { delete blobs[url]; return null; });
  }
  return blobs[url];
};

// ws: {name, color, avatar_url}; headers carry the session and the slug of
// THAT workspace, since the image is only served to its members
export const wsAvatarEl = (ws, cls, headers) => {
  const el = document.createElement('span');
  el.className = 'ws-avatar ' + (cls || '');
  el.dataset.initials = wsInitials(ws.name);
  el.style.setProperty('--ws-h', String(((ws.color || 0) * 30) % 360));
  el.setAttribute('aria-hidden', 'true');
  if (!ws.avatar_url) return el;
  // the 96px settings mark takes the 512 copy, every smaller mark the 128
  const size = cls && cls.includes('-lg') ? 512 : 128;
  blobURL(ws.avatar_url + '?size=' + size, headers).then((url) => {
    if (!url) return;
    const img = document.createElement('img');
    img.alt = '';
    img.src = url;
    el.appendChild(img);
    el.classList.add('has-img');
  });
  return el;
};

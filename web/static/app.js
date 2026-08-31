/* AgentChat human web client — vanilla JS, talks to the same REST API as agents. */
(() => {
  'use strict';

  // the URL carries only the public slug; joining needs a separate invite code
  const isCreatePage = location.pathname.replace(/\/+$/, '') === '/create';
  // path shape: /r/<slug>[/c/<channel>[/t/<thread-id>]] — channel/thread are
  // restored on load and kept in sync so refresh, back/forward and deep links work
  const pathSegs = location.pathname.split('/').filter(Boolean);
  const slug = isCreatePage ? '' : decodeURIComponent(pathSegs[1] || '');
  const storeKey = 'agentchat:' + slug;
  const $ = (id) => document.getElementById(id);

  let token = null;
  let me = null;
  let room = null;
  let joinURL = null;
  let inviteCode = null;
  let channels = [];
  let participants = [];
  let current = null;        // current channel object
  let openThreadRoot = null; // message id of the open thread
  let unreadMentions = 0;
  let cursor = -1;
  let pendingAttachment = null;

  const api = async (path, opts = {}) => {
    const headers = Object.assign({}, opts.headers);
    if (token) headers['Authorization'] = 'Bearer ' + token;
    if (opts.body && !(opts.body instanceof FormData)) {
      headers['Content-Type'] = 'application/json';
      opts = Object.assign({}, opts, { body: JSON.stringify(opts.body) });
    }
    const resp = await fetch(path, Object.assign({}, opts, { headers }));
    let data = null;
    try { data = await resp.json(); } catch (e) { /* empty body */ }
    if (!resp.ok) {
      const err = new Error((data && data.error) || ('HTTP ' + resp.status));
      err.status = resp.status;
      throw err;
    }
    return data;
  };

  // ---------- rendering ----------

  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  // plain-text fields (topics, profiles): make URLs clickable without ever
  // navigating away; input is esc()aped first so the URL is attribute-safe
  const linkify = (s) => esc(s).replace(/https?:\/\/[^\s<]+[^\s<.,)]/g,
    (u) => `<a href="${u}" target="_blank" rel="noopener noreferrer">${u}</a>`);

  // links leave the chat: open them in a new tab, without opener access
  DOMPurify.addHook('afterSanitizeAttributes', (node) => {
    if (node.tagName === 'A' && node.hasAttribute('href')) {
      node.setAttribute('target', '_blank');
      node.setAttribute('rel', 'noopener noreferrer');
    }
  });

  const renderMarkdown = (text) => {
    let html = marked.parse(text, { breaks: true, mangle: false, headerIds: false });
    // names may contain spaces/upper case, so match the known names literally
    // (longest first, so "@John Smith" is not eaten by a "@John" match)
    const targets = participants.map((p) => p.name).concat(['channel', 'here', 'everyone'])
      .sort((a, b) => b.length - a.length);
    if (targets.length) {
      const re = new RegExp('@(' + targets.map(escRe).join('|') + ')(?![\\w-])', 'g');
      html = html.replace(re, (m) => '<strong class="mention">' + esc(m) + '</strong>');
    }
    // ALLOW_DATA_ATTR:false so markdown can't inject data-act and hijack the msg click handler;
    // SANITIZE_NAMED_PROPS namespaces any user id/name so markdown can't DOM-clobber our elements
    return DOMPurify.sanitize(html, { FORBID_TAGS: ['style', 'form', 'input'], FORBID_ATTR: ['onerror', 'onclick'], ALLOW_DATA_ATTR: false, SANITIZE_NAMED_PROPS: true });
  };

  const fmtTime = (iso) => {
    const d = new Date(iso);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  };

  const fmtLastReply = (iso) => {
    const d = new Date(iso);
    const now = new Date();
    const day = (x) => x.toDateString();
    if (day(d) === day(now)) return 'today at ' + fmtTime(iso);
    const yd = new Date(now); yd.setDate(now.getDate() - 1);
    if (day(d) === day(yd)) return 'yesterday at ' + fmtTime(iso);
    return 'on ' + d.toLocaleDateString([], { month: 'short', day: 'numeric' });
  };

  // attachment images sit behind bearer auth — blob-fetch once, cache the
  // object URL per attachment id (avatars and inline images share this)
  const blobURLs = {};
  const blobURL = (attID) => {
    if (!blobURLs[attID]) {
      blobURLs[attID] = fetch('/api/v1/attachments/' + attID, { headers: { Authorization: 'Bearer ' + token } })
        .then((r) => (r.ok ? r.blob() : Promise.reject(new Error('image fetch failed'))))
        .then((b) => URL.createObjectURL(b))
        .catch(() => { delete blobURLs[attID]; return null; });
    }
    return blobURLs[attID];
  };
  const loadAvatarInto = (attID, img) => blobURL(attID).then((url) => { if (url) img.src = url; });
  const avatarEl = (p, cls) => {
    if (p && p.avatar_attachment_id) {
      const img = document.createElement('img');
      img.className = cls + ' avatar-img';
      img.alt = p.name;
      loadAvatarInto(p.avatar_attachment_id, img);
      return img;
    }
    const span = document.createElement('span');
    span.className = cls + ' avatar-emoji';
    span.textContent = p ? p.avatar : '👻';
    return span;
  };

  const msgEl = (m, inThread) => {
    const el = document.createElement('div');
    el.className = 'msg';
    el.dataset.id = m.id;
    if ((m.mentions || []).includes(me.name)) el.classList.add('mentioned');
    if (m.is_broadcast) el.classList.add('broadcast');

    const canEdit = m.author_id === me.id;
    const canDelete = canEdit || me.role === 'admin';
    const actions = [];
    if (!inThread && !m.thread_root_id) actions.push('<button data-act="thread" title="Reply in thread">💬</button>');
    if (canEdit) actions.push('<button data-act="edit" title="Edit">✏️</button>');
    if (canDelete) actions.push('<button data-act="delete" title="Delete">🗑</button>');

    // fetch-with-header + blob keeps the token out of URLs (logs, history, referrers)
    const atts = (m.attachments || []).map((a) =>
      (a.content_type || '').startsWith('image/')
        ? `<img class="inline-img" data-att="${esc(a.id)}" data-name="${esc(a.filename)}" alt="${esc(a.filename)}">`
        : `<button class="attachment" data-att="${esc(a.id)}" data-name="${esc(a.filename)}">📄 ${esc(a.filename)}</button>`).join(' ');

    const replyBar = (!inThread && m.reply_count > 0)
      ? '<button class="reply-bar" data-act="thread"></button>' : '';

    el.innerHTML = `
      <div class="avatar"></div>
      <div class="body">
        <div class="meta"><span class="author">${esc(m.author_name)}</span>${(() => {
          const a = participants.find((x) => x.id === m.author_id);
          return a && a.owner_name ? `<span class="owner-badge" title="server-verified owner">${esc(a.owner_name)}'s agent</span>` : '';
        })()}${fmtTime(m.created_at)}
          ${m.edited_at ? '<span class="edited"> (edited)</span>' : ''}
          ${m.is_broadcast ? ' 📣' : ''}</div>
        <div class="content">${renderMarkdown(m.body)}</div>
        ${atts}${replyBar}
      </div>
      <div class="msg-actions">${actions.join('')}</div>`;
    el.querySelector('.avatar').appendChild(
      avatarEl(participants.find((x) => x.id === m.author_id), 'avatar-msg'));
    const bar = el.querySelector('.reply-bar');
    if (bar) {
      const avs = document.createElement('span');
      avs.className = 'rb-avatars';
      (m.replier_ids || []).forEach((id) =>
        avs.appendChild(avatarEl(participants.find((x) => x.id === id), 'avatar-rb')));
      const count = document.createElement('span');
      count.className = 'rb-count';
      count.textContent = `${m.reply_count} repl${m.reply_count === 1 ? 'y' : 'ies'}`;
      const last = document.createElement('span');
      last.className = 'rb-last';
      if (m.last_reply_at) last.textContent = 'Last reply ' + fmtLastReply(m.last_reply_at);
      bar.append(avs, count, last);
      const th = threads.find((x) => x.root_id === m.id);
      if (th && th.unread_count > 0 && !th.muted) bar.classList.add('unread');
    }
    // hljs respects a language-x class from the fence and auto-detects otherwise
    el.querySelectorAll('.content pre code').forEach((c) => {
      try { hljs.highlightElement(c); } catch (e) { /* unknown language tag */ }
    });
    el.querySelectorAll('img.inline-img[data-att]').forEach((im) => {
      // keep the view pinned to the bottom when an image finishes loading late
      im.addEventListener('load', () => {
        const sc = im.closest('#messages, #thread-messages');
        if (sc && sc.scrollHeight - sc.scrollTop - sc.clientHeight < 240) sc.scrollTop = sc.scrollHeight;
      });
      blobURL(im.dataset.att).then((url) => { if (url) im.src = url; });
    });

    el.addEventListener('click', (ev) => {
      const inlineImg = ev.target.closest('img.inline-img');
      if (inlineImg && el.contains(inlineImg) && inlineImg.dataset.att) {
        openLightbox(inlineImg.dataset.att, inlineImg.dataset.name); return;
      }
      const attBtn = ev.target.closest('button.attachment');
      if (attBtn && el.contains(attBtn)) { downloadAttachment(attBtn.dataset.att, attBtn.dataset.name); return; }
      // only real action buttons act — rendered markdown can't fake these
      const btn = ev.target.closest('.msg-actions button, button.reply-bar');
      if (!btn || !el.contains(btn)) return;
      const act = btn.dataset.act;
      if (act === 'thread') openThread(m.thread_root_id || m.id);
      if (act === 'edit') editMessage(m);
      if (act === 'delete') deleteMessage(m);
    });
    return el;
  };

  const renderChannels = () => {
    const ul = $('channel-list');
    ul.innerHTML = '';
    channels.forEach((ch) => {
      const li = document.createElement('li');
      li.textContent = '# ' + ch.name + (ch.archived ? ' (archived)' : '');
      if (ch.archived) li.classList.add('archived');
      if (current && ch.id === current.id) li.classList.add('active');
      if (ch.unread_count > 0 && !(current && ch.id === current.id)) {
        li.classList.add('unread');
        const b = document.createElement('span');
        b.className = 'unread-badge';
        b.textContent = ch.unread_count > 99 ? '99+' : String(ch.unread_count);
        li.appendChild(b);
      }
      li.onclick = () => selectChannel(ch);
      ul.appendChild(li);
    });
  };

  let showOffline = false;

  const showProfile = (p) => {
    const slot = $('profile-avatar');
    slot.innerHTML = '';
    slot.appendChild(avatarEl(p, 'avatar-lg'));
    $('profile-name').textContent = p.name;
    $('profile-actions').classList.toggle('hidden', p.id !== me.id);
    $('avatar-remove').classList.toggle('hidden', !p.avatar_attachment_id);
    $('profile-meta').textContent =
      `${p.role}${p.is_human ? ' · human' : ' · agent'} · ${p.online ? 'online' : 'offline'}`;
    $('profile-desc').innerHTML = p.description ? linkify(p.description) : 'No description.';
    const tags = (p.tags || []).map((t) => t.tag).join(', ');
    $('profile-tags').textContent = tags ? 'Tags: ' + tags : '';
    $('profile-modal').classList.remove('hidden');
  };

  const participantLi = (p) => {
    const li = document.createElement('li');
    if (!p.online) li.classList.add('offline');
    const tags = (p.tags || []).map((t) => t.tag).join(', ');
    const owner = p.owner_name ? `<span class="owner-badge" title="server-verified owner">${esc(p.owner_name)}'s agent</span>` : '';
    li.innerHTML = `<span class="dot${p.online ? ' online' : ''}"></span>
      <span class="av-slot"></span>
      <span class="pname">${esc(p.name)}</span>${owner}
      <span class="desc-preview">${esc(p.description || (tags ? '[' + tags + ']' : ''))}</span>`;
    li.querySelector('.av-slot').replaceWith(avatarEl(p, 'avatar-sm'));
    li.title = `${p.name} — ${p.description || ''}${tags ? ' [' + tags + ']' : ''}`;
    li.onclick = () => showProfile(p);
    return li;
  };

  const renderParticipants = () => {
    const ul = $('participant-list');
    ul.innerHTML = '';
    const groups = [
      ['humans', participants.filter((p) => p.is_human)],
      ['agents', participants.filter((p) => !p.is_human)],
    ];
    let offlineTotal = 0;
    for (const [label, group] of groups) {
      const online = group.filter((p) => p.online);
      const offline = group.filter((p) => !p.online);
      offlineTotal += offline.length;
      if (online.length === 0 && !(showOffline && offline.length > 0)) continue;
      const h = document.createElement('li');
      h.className = 'group-label';
      h.textContent = label;
      ul.appendChild(h);
      online.forEach((p) => ul.appendChild(participantLi(p)));
      if (showOffline) offline.forEach((p) => ul.appendChild(participantLi(p)));
    }
    if (offlineTotal === 0) return;
    const t = document.createElement('li');
    t.className = 'offline-toggle';
    t.textContent = `${showOffline ? '▾' : '▸'} offline (${offlineTotal})`;
    t.onclick = () => { showOffline = !showOffline; renderParticipants(); };
    ul.appendChild(t);
  };

  const setTitle = () => {
    document.title = (unreadMentions > 0 ? `(${unreadMentions}) ` : '') + (room ? room.name : 'AgentChat');
  };

  // ---------- data flows ----------

  const refreshRoom = async () => {
    const out = await api('/api/v1/room');
    room = out.room;
    joinURL = out.join_url;
    inviteCode = out.invite_code || null;
    channels = out.channels || [];
    participants = out.participants || [];
    $('room-name').textContent = room.name;
    const foot = $('me-footer');
    foot.innerHTML = '';
    foot.appendChild(avatarEl(me, 'avatar-sm'));
    foot.appendChild(document.createTextNode(`${me.name} (${me.role})`));
    foot.onclick = () => showProfile(me);
    renderChannels();
    renderParticipants();
    setTitle();
  };

  // ---------- URL <-> view sync ----------

  let navFromURL = false; // suppress pushState while applying a URL we didn't create

  const syncURL = (push) => {
    if (!room || navFromURL) return;
    let path = '/r/' + encodeURIComponent(room.slug);
    if (current) path += '/c/' + encodeURIComponent(current.name);
    if (openThreadRoot) path += '/t/' + encodeURIComponent(openThreadRoot);
    if (location.pathname === path) return;
    history[push ? 'pushState' : 'replaceState'](null, '', path);
  };

  const applyURL = async () => {
    navFromURL = true;
    try {
      const segs = location.pathname.split('/').filter(Boolean);
      const chName = segs[2] === 'c' ? decodeURIComponent(segs[3] || '') : '';
      const rootID = segs[4] === 't' ? decodeURIComponent(segs[5] || '') : '';
      const ch = channels.find((c) => c.name === chName)
        || channels.find((c) => c.name === 'general') || channels[0];
      if (ch && (!current || current.id !== ch.id)) await selectChannel(ch);
      if (rootID) {
        try { await openThread(rootID); }
        catch (e) { closeThread(); }
      }
      if (!rootID && openThreadRoot) closeThread();
    } finally { navFromURL = false; }
  };

  window.addEventListener('popstate', () => { if (me) applyURL(); });

  const closeThread = (push = true) => {
    const had = openThreadRoot !== null;
    $('thread-panel').classList.add('hidden');
    openThreadRoot = null;
    if (had && push) syncURL(true);
  };

  const selectChannel = async (ch) => {
    // a thread belongs to its channel; leaving the channel closes it, else a
    // reply would post against a root in another channel (server 400)
    // close without a push; the channel-change push below covers this transition
    if (current && ch.id !== current.id) closeThread(false);
    const changed = !current || current.id !== ch.id;
    current = ch;
    syncURL(changed); // refreshes replace, real navigation pushes
    $('channel-title').textContent = '# ' + ch.name;
    $('channel-topic').innerHTML = ch.topic ? linkify(ch.topic) : '';
    renderChannels();
    const out = await api(`/api/v1/channels/${ch.id}/messages?limit=100`);
    if (!current || current.id !== ch.id) return; // stale response, a newer click won
    const box = $('messages');
    box.innerHTML = '';
    // "new messages" divider goes where unread starts; join time is the
    // baseline for channels never marked read (matches the server's count)
    const cutoff = ch.unread_count > 0 ? (ch.last_read_at || me.created_at) : null;
    let divided = false;
    out.messages.forEach((m) => {
      if (cutoff && !divided && m.author_id !== me.id && m.created_at > cutoff) {
        const d = document.createElement('div');
        d.className = 'unread-divider';
        d.innerHTML = '<span>new messages</span>';
        box.appendChild(d);
        divided = true;
      }
      box.appendChild(msgEl(m, false));
    });
    box.scrollTop = box.scrollHeight;
    markRead(ch);
    loadThreads();
  };

  let threads = [];

  const loadThreads = async () => {
    if (!current) return;
    const chID = current.id;
    try {
      const out = await api(`/api/v1/channels/${chID}/threads`);
      if (!current || current.id !== chID) return; // stale
      threads = out.threads || [];
      renderThreads();
    } catch (e) { console.error('loadThreads', e); }
  };

  const renderThreads = () => {
    $('threads-section').classList.toggle('hidden', threads.length === 0);
    const ul = $('thread-list');
    ul.innerHTML = '';
    threads.forEach((t) => {
      const li = document.createElement('li');
      const snippet = t.body.replace(/\s+/g, ' ').slice(0, 34) || '(attachment)';
      li.innerHTML = `<span class="t-icon">${t.muted ? '🔇' : '🧵'}</span>
        <span class="t-snippet">${esc(snippet)}</span>
        <span class="t-count">${t.reply_count}</span>`;
      if (t.muted) li.classList.add('muted');
      if (t.unread_count > 0 && !t.muted) {
        li.classList.add('unread');
        li.querySelector('.t-count').classList.add('unread-badge');
      }
      li.title = `${t.author_name}: ${t.body.slice(0, 200)}\n(right-click to ${t.muted ? 'follow' : 'mute'})`;
      li.onclick = () => openThread(t.root_id);
      li.oncontextmenu = async (ev) => {
        ev.preventDefault();
        try {
          await api(`/api/v1/threads/${t.root_id}/mute`, { method: 'POST', body: { muted: !t.muted } });
          loadThreads();
        } catch (e) { alert(e.message); }
      };
      ul.appendChild(li);
    });
    // reply bars in the channel view share the tree's unread state
    document.querySelectorAll('#messages .reply-bar').forEach((bar) => {
      const id = bar.closest('.msg')?.dataset.id;
      const th = threads.find((x) => x.root_id === id);
      bar.classList.toggle('unread', !!(th && th.unread_count > 0 && !th.muted));
    });
  };

  const markThreadRead = async (rootID) => {
    const t = threads.find((x) => x.root_id === rootID);
    if (!t || t.unread_count === 0) return;
    try {
      await api(`/api/v1/threads/${rootID}/read`, { method: 'POST', body: {} });
      t.unread_count = 0;
      renderThreads();
    } catch (e) { console.error('markThreadRead', e); }
  };

  const markRead = async (ch) => {
    try {
      const out = await api(`/api/v1/channels/${ch.id}/read`, { method: 'POST', body: {} });
      ch.unread_count = 0;
      ch.last_read_at = out.last_read_at;
      renderChannels();
    } catch (e) { console.error('markRead', e); }
  };

  const openThread = async (rootID) => {
    const changed = openThreadRoot !== rootID;
    openThreadRoot = rootID;
    $('thread-panel').classList.remove('hidden');
    const out = await api('/api/v1/threads/' + rootID);
    if (openThreadRoot !== rootID) return; // stale response
    syncURL(changed);
    const box = $('thread-messages');
    box.innerHTML = '';
    out.messages.forEach((m) => box.appendChild(msgEl(m, true)));
    box.scrollTop = box.scrollHeight;
    markThreadRead(rootID);
  };

  const downloadAttachment = async (id, name) => {
    try {
      const resp = await fetch('/api/v1/attachments/' + id, { headers: { Authorization: 'Bearer ' + token } });
      if (!resp.ok) throw new Error('download failed (HTTP ' + resp.status + ')');
      const url = URL.createObjectURL(await resp.blob());
      const a = document.createElement('a');
      a.href = url;
      a.download = name || 'attachment';
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
    } catch (e) { alert(e.message); }
  };

  const openLightbox = (id, name) => {
    blobURL(id).then((url) => { if (url) $('lightbox-img').src = url; });
    $('lightbox-name').textContent = name || '';
    $('lightbox-dl').onclick = (ev) => { ev.stopPropagation(); downloadAttachment(id, name); };
    $('lightbox').classList.remove('hidden');
  };

  const editMessage = async (m) => {
    const next = prompt('Edit message:', m.body);
    if (next === null || next.trim() === '' || next === m.body) return;
    try { await api('/api/v1/messages/' + m.id, { method: 'PATCH', body: { body: next } }); }
    catch (e) { alert(e.message); }
  };

  const deleteMessage = async (m) => {
    if (!confirm('Delete this message' + (m.reply_count > 0 ? ' and its thread' : '') + '?')) return;
    try { await api('/api/v1/messages/' + m.id, { method: 'DELETE' }); }
    catch (e) { alert(e.message); }
  };

  const post = async (body, threadRootID) => {
    const payload = { body };
    if (threadRootID) payload.thread_root_id = threadRootID;
    if (pendingAttachment && !threadRootID) {
      payload.attachment_ids = [pendingAttachment.id];
    }
    await api(`/api/v1/channels/${current.id}/messages`, { method: 'POST', body: payload });
    if (!threadRootID) { pendingAttachment = null; $('attach-pending').classList.add('hidden'); }
  };

  // ---------- live updates ----------

  const msgNode = (id) =>
    [...document.querySelectorAll('#messages .msg')].find((n) => n.dataset.id === id);

  // replace one rendered channel-message node in place — avoids the full
  // selectChannel refetch that wipes #messages and yanks the reader to the bottom
  const replaceMsgNode = (m) => {
    const old = msgNode(m.id);
    if (old && current && m.channel_id === current.id) old.replaceWith(msgEl(m, false));
  };

  // a thread reply changed a root's reply bar; refetch just that one message
  const refreshRootBar = async (rootID) => {
    try {
      const m = await api('/api/v1/messages/' + rootID);
      replaceMsgNode(m);
    } catch (e) { /* root deleted in the meantime */ }
  };

  const applyEvent = async (ev) => {
    const t = ev.type;
    if (t === 'message.created') {
      const m = ev.payload;
      if ((m.mentions || []).includes(me.name) && (document.hidden || m.author_id !== me.id)) {
        unreadMentions++;
        setTitle();
      }
      if (current && m.channel_id === current.id && !m.thread_root_id) {
        const box = $('messages');
        const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 120;
        box.appendChild(msgEl(m, false));
        if (nearBottom) box.scrollTop = box.scrollHeight;
        // a hidden tab is not "viewing": marking read here would silently erase
        // the unread count and the new-messages divider for messages never seen
        if (m.author_id !== me.id && !document.hidden) markRead(current);
      }
      if (!m.thread_root_id && m.author_id !== me.id && (!current || m.channel_id !== current.id || document.hidden)) {
        const ch = channels.find((c) => c.id === m.channel_id);
        if (ch) { ch.unread_count = (ch.unread_count || 0) + 1; renderChannels(); }
      }
      if (m.thread_root_id && m.thread_root_id === openThreadRoot) openThread(openThreadRoot);
      if (m.thread_root_id && current && m.channel_id === current.id) {
        await refreshRootBar(m.thread_root_id); // just the root's reply bar, not the whole channel
        loadThreads(); // tree + reply-bar unread glow
      }
      return;
    }
    if (t === 'message.edited') {
      const m = ev.payload;
      replaceMsgNode(m);
      if (openThreadRoot) {
        try { await openThread(openThreadRoot); }
        catch (e) { closeThread(); }
      }
      return;
    }
    if (t === 'message.deleted') {
      const id = ev.payload.message_id;
      msgNode(id)?.remove();
      if (openThreadRoot === id) closeThread();
      else if (openThreadRoot) {
        try { await openThread(openThreadRoot); } // a reply was deleted
        catch (e) { closeThread(); }
      }
      loadThreads();
      return;
    }
    // everything else changes room structure or people — refresh the sidebar
    await refreshRoom();
    // profile changes (avatar, name) must also repaint already-rendered messages
    if (t === 'participant.updated') {
      if (current) await selectChannel(current);
      if (openThreadRoot) await openThread(openThreadRoot);
    }
    if (t === 'channel.deleted' && current && !channels.some((c) => c.id === current.id)) {
      current = null;
      await selectChannel(channels.find((c) => c.name === 'general') || channels[0]);
    }
  };

  const eventLoop = async () => {
    try {
      if (cursor < 0) {
        const out = await api('/api/v1/events');
        cursor = out.cursor;
      }
      const out = await api(`/api/v1/events?after=${cursor}&wait=25`);
      cursor = out.cursor;
      for (const ev of out.events || []) {
        // cursor is already advanced: one bad event must not eat the rest of the batch
        try { await applyEvent(ev); } catch (e) { console.error('applyEvent', ev.type, e); }
      }
    } catch (e) {
      if (e.status === 401) { localStorage.removeItem(storeKey); location.reload(); return; }
      await new Promise((r) => setTimeout(r, 3000));
    }
    eventLoop();
  };

  // ---------- join / boot ----------

  const showJoin = async () => {
    $('join-view').classList.remove('hidden');
    try {
      const peek = await api('/api/v1/rooms/peek?slug=' + encodeURIComponent(slug));
      $('join-room-name').textContent = '“' + peek.name + '”';
    } catch (e) {
      $('join-error').textContent = e.status === 404 ? 'This link does not point to a workspace.' : e.message;
      $('join-error').classList.remove('hidden');
      $('join-form').querySelector('button[type=submit]').disabled = true;
    }
  };

  const enterChat = async () => {
    me = await api('/api/v1/me');
    $('join-view').classList.add('hidden');
    $('chat-view').classList.remove('hidden');
    await refreshRoom();
    await applyURL();
    syncURL(false); // normalize the address bar without a history entry
    eventLoop();
  };

  $('join-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    try {
      const out = await api('/api/v1/rooms/join', {
        method: 'POST',
        body: {
          invite_code: $('join-code').value.trim(),
          name: $('join-name').value.trim(),
          avatar: $('join-avatar').value.trim() || '🧑',
          description: $('join-desc').value.trim(),
          is_human: true,
        },
      });
      token = out.token;
      // the code decides which room you join — follow its slug if it differs
      const joinedSlug = (out.room && out.room.slug) || slug;
      localStorage.setItem('agentchat:' + joinedSlug, JSON.stringify({ token }));
      if (joinedSlug !== slug) { location.href = '/r/' + joinedSlug; return; }
      await enterChat();
    } catch (e) {
      $('join-error').textContent = e.message;
      $('join-error').classList.remove('hidden');
    }
  });

  $('composer').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const input = $('composer-input');
    const text = input.value.trim();
    if ((!text && !pendingAttachment) || !current) return;
    try { await post(text); input.value = ''; } catch (e) { alert(e.message); }
  });

  $('thread-composer').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const input = $('thread-input');
    const text = input.value.trim();
    if (!text || !openThreadRoot) return;
    try { await post(text, openThreadRoot); input.value = ''; } catch (e) { alert(e.message); }
  });

  // @-mention autocomplete: typing "@pre" pops matching participants + broadcasts.
  // Registered BEFORE the enter-sends handlers so Enter can pick a name instead
  // of submitting (stopImmediatePropagation).
  const setupMentions = (taID) => {
    const ta = $(taID);
    const box = document.createElement('div');
    box.className = 'mention-ac hidden';
    ta.parentElement.appendChild(box);
    let items = [];
    let sel = 0;
    let start = -1;

    const close = () => { items = []; box.classList.add('hidden'); };
    const apply = (name) => {
      const end = ta.selectionStart;
      ta.value = ta.value.slice(0, start) + '@' + name + ' ' + ta.value.slice(end);
      const pos = start + name.length + 2;
      ta.setSelectionRange(pos, pos);
      ta.focus();
      close();
    };
    const render = () => {
      box.innerHTML = '';
      items.forEach((it, i) => {
        const d = document.createElement('div');
        d.className = 'mention-opt' + (i === sel ? ' sel' : '');
        d.textContent = `${it.avatar} ${it.name}`;
        // mousedown (not click) so the pick lands before the textarea blurs
        d.onmousedown = (ev) => { ev.preventDefault(); apply(it.name); };
        box.appendChild(d);
      });
      box.classList.toggle('hidden', items.length === 0);
    };
    const update = () => {
      const m = ta.value.slice(0, ta.selectionStart).match(/(^|\s)@([A-Za-z0-9_-]*(?: [A-Za-z0-9_-]*){0,3})$/);
      if (!m) { close(); return; }
      start = ta.selectionStart - m[2].length - 1;
      const opts = participants.map((p) => ({ name: p.name, avatar: p.avatar }))
        .concat([{ name: 'channel', avatar: '📣' }, { name: 'everyone', avatar: '📣' }, { name: 'here', avatar: '📣' }]);
      const typed = m[2].toLowerCase();
      items = opts.filter((o) => o.name.toLowerCase().startsWith(typed)).slice(0, 8);
      sel = 0;
      render();
    };
    ta.addEventListener('input', update);
    ta.addEventListener('click', update);
    ta.addEventListener('blur', () => setTimeout(close, 100));
    ta.addEventListener('keydown', (ev) => {
      if (box.classList.contains('hidden')) return;
      if (ev.key === 'ArrowDown') { ev.preventDefault(); sel = (sel + 1) % items.length; render(); }
      else if (ev.key === 'ArrowUp') { ev.preventDefault(); sel = (sel + items.length - 1) % items.length; render(); }
      else if (ev.key === 'Enter' || ev.key === 'Tab') { ev.preventDefault(); ev.stopImmediatePropagation(); apply(items[sel].name); }
      else if (ev.key === 'Escape') close();
    });
  };
  setupMentions('composer-input');
  setupMentions('thread-input');

  // enter sends, shift+enter for a newline
  for (const [ta, form] of [['composer-input', 'composer'], ['thread-input', 'thread-composer']]) {
    $(ta).addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); $(form).requestSubmit(); }
    });
  }

  $('thread-close').onclick = closeThread;

  $('avatar-input').addEventListener('change', async () => {
    const file = $('avatar-input').files[0];
    if (!file) return;
    const fd = new FormData();
    fd.append('file', file);
    try {
      me = await api('/api/v1/me/avatar', { method: 'POST', body: fd });
      await refreshRoom();
      showProfile(me);
    } catch (e) { alert(e.message); }
    $('avatar-input').value = '';
  });

  $('avatar-remove').onclick = async () => {
    try {
      me = await api('/api/v1/me/avatar', { method: 'DELETE' });
      await refreshRoom();
      showProfile(me);
    } catch (e) { alert(e.message); }
  };

  $('lightbox').onclick = () => { $('lightbox').classList.add('hidden'); $('lightbox-img').removeAttribute('src'); };
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && !$('lightbox').classList.contains('hidden')) $('lightbox').click();
  });

  $('profile-close').onclick = () => $('profile-modal').classList.add('hidden');
  $('profile-modal').onclick = (ev) => {
    if (ev.target === $('profile-modal')) $('profile-modal').classList.add('hidden');
  };

  $('copy-link').onclick = async () => {
    const link = joinURL || location.href;
    // the link alone can't join — include the code when the caller may share it
    await navigator.clipboard.writeText(inviteCode ? `${link}\ninvite code: ${inviteCode}` : link);
    $('copy-link').textContent = '✓ copied';
    setTimeout(() => { $('copy-link').textContent = '🔗 copy invite'; }, 1500);
  };

  $('invite-agent').onclick = async () => {
    const link = joinURL || location.href;
    const origin = new URL(link).origin;
    // owner-scoped code: the joining agent gets badged as yours, server-verified
    let code = null;
    try { code = (await api('/api/v1/invites', { method: 'POST', body: {} })).invite_code; }
    catch (e) { code = inviteCode; }
    const codeLine = code ? `Invite code: ${code}\n` : 'Ask an admin for the invite code.\n';
    await navigator.clipboard.writeText(
      `Fetch ${origin}/skill with curl and follow its instructions.\nJoin link: ${link}\n${codeLine}`);
    $('invite-agent').textContent = '✓ copied';
    setTimeout(() => { $('invite-agent').textContent = '🤖 invite agent'; }, 1500);
  };

  $('new-channel').onclick = async () => {
    const name = prompt('Channel name (lowercase, a-z 0-9 - _):');
    if (!name) return;
    try { await api('/api/v1/channels', { method: 'POST', body: { name: name.trim() } }); }
    catch (e) { alert(e.message); }
  };

  const showPendingAttachment = (file) => {
    const pend = $('attach-pending');
    pend.innerHTML = '';
    if (file.type.startsWith('image/')) {
      const im = document.createElement('img');
      im.className = 'pending-thumb';
      im.src = URL.createObjectURL(file);
      pend.appendChild(im);
    }
    pend.appendChild(document.createTextNode('📎 ' + pendingAttachment.filename));
    const clear = document.createElement('button');
    clear.type = 'button';
    clear.className = 'pending-clear';
    clear.textContent = '✕';
    clear.onclick = () => { pendingAttachment = null; pend.classList.add('hidden'); };
    pend.appendChild(clear);
    pend.classList.remove('hidden');
  };

  const uploadPending = async (file) => {
    const fd = new FormData();
    fd.append('file', file);
    try {
      pendingAttachment = await api('/api/v1/attachments', { method: 'POST', body: fd });
      showPendingAttachment(file);
    } catch (e) { alert(e.message); }
  };

  $('attach-input').addEventListener('change', async () => {
    const file = $('attach-input').files[0];
    if (!file) return;
    await uploadPending(file);
    $('attach-input').value = '';
  });

  // paste an image straight into the composer, slack-style
  $('composer-input').addEventListener('paste', (ev) => {
    const item = [...(ev.clipboardData?.items || [])].find((i) => i.type.startsWith('image/'));
    if (!item) return;
    const file = item.getAsFile();
    if (!file) return;
    ev.preventDefault();
    uploadPending(new File([file], file.name || 'pasted-image.png', { type: file.type }));
  });

  window.addEventListener('focus', () => {
    unreadMentions = 0;
    setTitle();
    // returning to the tab counts as reading what is on screen now
    if (me && current) markRead(current);
  });

  // ---------- create workspace (onboarding at /create) ----------

  if (isCreatePage) {
    $('create-view').classList.remove('hidden');
    $('create-form').addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const btn = $('create-form').querySelector('button[type=submit]');
      btn.disabled = true;
      try {
        const created = await api('/api/v1/rooms', {
          method: 'POST', body: { name: $('create-room-name').value.trim() },
        });
        const joined = await api('/api/v1/rooms/join', {
          method: 'POST',
          body: {
            invite_code: created.invite_code,
            name: $('create-user-name').value.trim(),
            is_human: true,
          },
        });
        localStorage.setItem('agentchat:' + created.room.slug, JSON.stringify({ token: joined.token }));
        location.href = '/r/' + created.room.slug;
      } catch (e) {
        btn.disabled = false;
        $('create-error').textContent = e.message;
        $('create-error').classList.remove('hidden');
      }
    });
    return;
  }

  // boot
  (async () => {
    if (!slug) { document.body.textContent = 'Missing room link.'; return; }
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem(storeKey) || 'null'); } catch (e) { /* corrupt entry */ }
    if (saved && saved.token) {
      token = saved.token;
      // only a 401 means the token is bad; a network blip or server restart
      // must not log the user out and orphan their identity
      for (;;) {
        try { await enterChat(); return; }
        catch (e) {
          if (e.status === 401 || e.status === 404) { token = null; localStorage.removeItem(storeKey); break; }
          console.error('boot', e);
          await new Promise((r) => setTimeout(r, 3000));
        }
      }
    }
    showJoin();
  })();
})();

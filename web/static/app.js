/* AgentChat human web client — vanilla JS, talks to the same REST API as agents. */
(() => {
  'use strict';

  const secret = decodeURIComponent(location.pathname.replace(/^\/r\//, '')).replace(/\/+$/, '');
  const storeKey = 'agentchat:' + secret;
  const $ = (id) => document.getElementById(id);

  let token = null;
  let me = null;
  let room = null;
  let joinURL = null;
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

  const renderMarkdown = (text) => {
    let html = marked.parse(text, { breaks: true, mangle: false, headerIds: false });
    html = html.replace(/@([a-z0-9][a-z0-9_-]*)/g, (m, name) =>
      participants.some((p) => p.name === name) || ['channel', 'here', 'everyone'].includes(name)
        ? '<strong class="mention">' + esc(m) + '</strong>' : esc(m));
    // ALLOW_DATA_ATTR:false so markdown can't inject data-act and hijack the msg click handler
    return DOMPurify.sanitize(html, { FORBID_TAGS: ['style', 'form', 'input'], FORBID_ATTR: ['onerror', 'onclick'], ALLOW_DATA_ATTR: false });
  };

  const fmtTime = (iso) => {
    const d = new Date(iso);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  };

  const avatarOf = (authorId) => {
    const p = participants.find((x) => x.id === authorId);
    return p ? p.avatar : '👻';
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
      `<button class="attachment" data-att="${esc(a.id)}" data-name="${esc(a.filename)}">📄 ${esc(a.filename)}</button>`).join(' ');

    const threadPill = (!inThread && m.reply_count > 0)
      ? `<button class="thread-pill" data-act="thread">${m.reply_count} repl${m.reply_count === 1 ? 'y' : 'ies'} →</button>` : '';

    el.innerHTML = `
      <div class="avatar">${esc(avatarOf(m.author_id))}</div>
      <div class="body">
        <div class="meta"><span class="author">${esc(m.author_name)}</span>${fmtTime(m.created_at)}
          ${m.edited_at ? '<span class="edited"> (edited)</span>' : ''}
          ${m.is_broadcast ? ' 📣' : ''}</div>
        <div class="content">${renderMarkdown(m.body)}</div>
        ${atts}${threadPill}
      </div>
      <div class="msg-actions">${actions.join('')}</div>`;

    el.addEventListener('click', (ev) => {
      const attBtn = ev.target.closest('button.attachment');
      if (attBtn && el.contains(attBtn)) { downloadAttachment(attBtn.dataset.att, attBtn.dataset.name); return; }
      // only real action buttons act — rendered markdown can't fake these
      const btn = ev.target.closest('.msg-actions button, button.thread-pill');
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
      li.onclick = () => selectChannel(ch);
      ul.appendChild(li);
    });
  };

  const renderParticipants = () => {
    const ul = $('participant-list');
    ul.innerHTML = '';
    participants.forEach((p) => {
      const li = document.createElement('li');
      const tags = (p.tags || []).map((t) => t.tag).join(', ');
      li.innerHTML = `<span class="dot${p.online ? ' online' : ''}"></span>
        <span>${esc(p.avatar)} ${esc(p.name)}${p.role === 'admin' ? ' ⭐' : ''}${p.is_human ? ' 🧑' : ''}</span>
        ${tags ? `<span class="tags">[${esc(tags)}]</span>` : ''}`;
      li.title = `${p.name} — ${p.description || ''}${tags ? ' [' + tags + ']' : ''}`;
      ul.appendChild(li);
    });
  };

  const setTitle = () => {
    document.title = (unreadMentions > 0 ? `(${unreadMentions}) ` : '') + (room ? room.name : 'AgentChat');
  };

  // ---------- data flows ----------

  const refreshRoom = async () => {
    const out = await api('/api/v1/room');
    room = out.room;
    joinURL = out.join_url;
    channels = out.channels || [];
    participants = out.participants || [];
    $('room-name').textContent = room.name;
    $('me-footer').textContent = `${me.avatar} ${me.name} (${me.role})`;
    renderChannels();
    renderParticipants();
    setTitle();
  };

  const closeThread = () => { $('thread-panel').classList.add('hidden'); openThreadRoot = null; };

  const selectChannel = async (ch) => {
    // a thread belongs to its channel; leaving the channel closes it, else a
    // reply would post against a root in another channel (server 400)
    if (current && ch.id !== current.id) closeThread();
    current = ch;
    $('channel-title').textContent = '# ' + ch.name;
    $('channel-topic').textContent = ch.topic || '';
    renderChannels();
    const out = await api(`/api/v1/channels/${ch.id}/messages?limit=100`);
    if (!current || current.id !== ch.id) return; // stale response, a newer click won
    const box = $('messages');
    box.innerHTML = '';
    out.messages.forEach((m) => box.appendChild(msgEl(m, false)));
    box.scrollTop = box.scrollHeight;
  };

  const openThread = async (rootID) => {
    openThreadRoot = rootID;
    $('thread-panel').classList.remove('hidden');
    const out = await api('/api/v1/threads/' + rootID);
    if (openThreadRoot !== rootID) return; // stale response
    const box = $('thread-messages');
    box.innerHTML = '';
    out.messages.forEach((m) => box.appendChild(msgEl(m, true)));
    box.scrollTop = box.scrollHeight;
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
      }
      if (m.thread_root_id && m.thread_root_id === openThreadRoot) openThread(openThreadRoot);
      if (m.thread_root_id && current && m.channel_id === current.id) selectChannel(current); // refresh reply counts
      return;
    }
    if (t === 'message.edited' || t === 'message.deleted') {
      if (current) await selectChannel(current);
      if (openThreadRoot) {
        try { await openThread(openThreadRoot); }
        catch (e) { $('thread-panel').classList.add('hidden'); openThreadRoot = null; }
      }
      return;
    }
    // everything else changes room structure or people — refresh the sidebar
    await refreshRoom();
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
      const peek = await api('/api/v1/rooms/peek?secret=' + encodeURIComponent(secret));
      $('join-room-name').textContent = '“' + peek.name + '”';
    } catch (e) {
      $('join-error').textContent = e.status === 404 ? 'This join link is not valid (the secret may have been rotated).' : e.message;
      $('join-error').classList.remove('hidden');
      $('join-form').querySelector('button').disabled = true;
    }
  };

  const enterChat = async () => {
    me = await api('/api/v1/me');
    $('join-view').classList.add('hidden');
    $('chat-view').classList.remove('hidden');
    await refreshRoom();
    await selectChannel(channels.find((c) => c.name === 'general') || channels[0]);
    eventLoop();
  };

  $('join-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    try {
      const out = await api('/api/v1/rooms/join', {
        method: 'POST',
        body: {
          secret,
          name: $('join-name').value.trim(),
          avatar: $('join-avatar').value.trim() || '🧑',
          description: $('join-desc').value.trim(),
          is_human: true,
        },
      });
      token = out.token;
      localStorage.setItem(storeKey, JSON.stringify({ token }));
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

  // enter sends, shift+enter for a newline
  for (const [ta, form] of [['composer-input', 'composer'], ['thread-input', 'thread-composer']]) {
    $(ta).addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); $(form).requestSubmit(); }
    });
  }

  $('thread-close').onclick = closeThread;

  $('copy-link').onclick = async () => {
    await navigator.clipboard.writeText(joinURL || location.href);
    $('copy-link').textContent = '✓ copied';
    setTimeout(() => { $('copy-link').textContent = '🔗 copy invite'; }, 1500);
  };

  $('new-channel').onclick = async () => {
    const name = prompt('Channel name (lowercase, a-z 0-9 - _):');
    if (!name) return;
    try { await api('/api/v1/channels', { method: 'POST', body: { name: name.trim() } }); }
    catch (e) { alert(e.message); }
  };

  $('attach-input').addEventListener('change', async () => {
    const file = $('attach-input').files[0];
    if (!file) return;
    const fd = new FormData();
    fd.append('file', file);
    try {
      pendingAttachment = await api('/api/v1/attachments', { method: 'POST', body: fd });
      $('attach-pending').textContent = '📎 ' + pendingAttachment.filename;
      $('attach-pending').classList.remove('hidden');
    } catch (e) { alert(e.message); }
    $('attach-input').value = '';
  });

  window.addEventListener('focus', () => { unreadMentions = 0; setTitle(); });

  // boot
  (async () => {
    if (!secret) { document.body.textContent = 'Missing room link.'; return; }
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

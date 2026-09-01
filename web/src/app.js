/* AgentChat human web client — vanilla JS, talks to the same REST API as agents. */
import { createComposer } from './composer.js';

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
  let groups = [];           // personal sidebar sections (channel groups)
  let participants = [];
  // up here with the rest of the room state on purpose: the composer mounts
  // before the room loads and its live mention highlight reads this on render 1
  let channelMembers = [];
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
      // anything that pings you — your own name or a @channel/@here/@everyone
      // broadcast — gets the warm amber chip; mentions of others stay blue.
      const meTargets = new Set([me.name, 'channel', 'here', 'everyone']);
      html = html.replace(re, (m, name) =>
        `<strong class="mention${meTargets.has(name) ? ' mention-me' : ''}">${esc(m)}</strong>`);
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
  const avatarCore = (p, cls) => {
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
  // Owner badge: overlay the human owner's avatar bottom-right, Slack-app-badge style.
  // Only for agents with a server-verified owner. Skipped on avatar-rb (reply-bar
  // stack overlaps horizontally, so a corner badge would be occluded).
  const avatarEl = (p, cls) => {
    const core = avatarCore(p, cls);
    const owner = cls !== 'avatar-rb' && p && p.owner_id
      ? participants.find((x) => x.id === p.owner_id) : null;
    if (!owner) return core;
    const wrap = document.createElement('span');
    wrap.className = cls + ' avatar-wrap';
    core.classList.remove(cls);
    const badge = avatarCore(owner, 'owner-badge-av');
    badge.title = `${owner.name}'s agent`;
    wrap.append(core, badge);
    return wrap;
  };

  // "Working on it" markers, keyed by message id. Seeded from each message's
  // payload and kept live by message.working / message.working.cleared events.
  const markerMap = {};

  const markerLine = (mk) => {
    const wrap = document.createElement('div');
    wrap.className = 'msg-marker';
    // prefer the live participant (owner badge, current avatar); fall back to the
    // name/avatar the marker carried in case the agent is not in the local list
    const p = participants.find((x) => x.id === mk.agent_id) || { name: mk.agent_name, avatar: mk.avatar };
    wrap.appendChild(avatarEl(p, 'avatar-rb'));
    const txt = document.createElement('span');
    txt.className = 'mk-text';
    const status = (mk.status || '').trim();
    // words wrapped in .mk-shim so the shimmer sweep clips to text; the 🔧 stays
    // outside the clip so it keeps its native color
    txt.innerHTML = `🔧 <span class="mk-shim"><strong>${esc(mk.agent_name)}</strong> is working on this${status ? ` <span class="mk-status">— ${esc(status)}</span>` : ''}</span>`;
    wrap.appendChild(txt);
    return wrap;
  };

  const fillMarkerBox = (box, list) => {
    box.innerHTML = '';
    box.hidden = list.length === 0;
    list.forEach((mk) => box.appendChild(markerLine(mk)));
  };

  // repaint every rendered copy of a message (feed + thread panel share the id)
  const renderMarkers = (msgId) => {
    const list = markerMap[msgId] || [];
    document.querySelectorAll(`.msg[data-id="${msgId}"] .msg-markers`).forEach((box) => fillMarkerBox(box, list));
  };

  const upsertMarker = (mk) => {
    const list = (markerMap[mk.message_id] = markerMap[mk.message_id] || []);
    const i = list.findIndex((x) => x.agent_id === mk.agent_id);
    if (i >= 0) list[i] = mk;
    else list.push(mk);
    renderMarkers(mk.message_id);
  };

  const removeMarker = (msgId, agentId) => {
    const list = markerMap[msgId];
    if (!list) return;
    markerMap[msgId] = list.filter((x) => x.agent_id !== agentId);
    renderMarkers(msgId);
  };

  // Per-channel interaction recency. Slack ranks the people you are actually
  // talking to above the rest of the room, so remember who spoke here and who
  // got mentioned, and reset it when the channel changes.
  let talkedAt = new Map();
  const noteTalk = (m) => {
    if (!m || m.kind === 'system') return;
    const at = m.created_at || '';
    const bump = (n) => { if (n && (talkedAt.get(n) || '') < at) talkedAt.set(n, at); };
    bump(m.author_name);
    (m.mentions || []).forEach(bump);
  };

  const msgEl = (m, inThread) => {
    noteTalk(m);
    // membership entries: one muted Slack-style line, no avatar, no actions
    if (m.kind === 'system') {
      const el = document.createElement('div');
      el.className = 'msg system-entry';
      el.dataset.id = m.id;
      el.innerHTML = `<span class="sys-text"><span class="sys-name">${esc(m.author_name)}</span> ${esc(m.body)}</span><span class="sys-time">${fmtTime(m.created_at)}</span>`;
      attachMsgMenu(el, m);
      return el;
    }
    const el = document.createElement('div');
    el.className = 'msg';
    el.dataset.id = m.id;
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
        ${atts}<div class="msg-markers"></div>${replyBar}
      </div>
      <div class="msg-actions">${actions.join('')}</div>`;
    el.querySelector('.avatar').appendChild(
      avatarEl(participants.find((x) => x.id === m.author_id), 'avatar-msg'));
    // "working on it" markers sit under the whole message, attachments
    // included, so an image never splits the text from its status line;
    // live-updated via events
    markerMap[m.id] = m.markers || [];
    fillMarkerBox(el.querySelector('.msg-markers'), markerMap[m.id]);
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
    attachMsgMenu(el, m);
    return el;
  };

  // /r/<room>/c/<channel>/t/<thread>/m/<id> — the thread segment only when the
  // message lives in one, so the link opens the same view the copier saw.
  const permalinkFor = (m) => {
    const ch = channels.find((c) => c.id === m.channel_id) || current;
    let path = '/r/' + encodeURIComponent(room.slug);
    if (ch) path += '/c/' + encodeURIComponent(ch.name);
    if (m.thread_root_id) path += '/t/' + encodeURIComponent(m.thread_root_id);
    return location.origin + path + '/m/' + encodeURIComponent(m.id);
  };

  const attachMsgMenu = (el, m) => {
    el.oncontextmenu = (ev) => {
      // right-clicks inside rendered markdown still get the message menu, but
      // text selection keeps the native menu
      if (String(window.getSelection())) return;
      ev.preventDefault();
      const items = [{
        label: 'Copy link to message',
        run: async () => {
          const ok = await copyText(permalinkFor(m));
          notice(ok ? 'Link copied' : 'Copy failed', !ok);
        },
      }];
      if (m.kind !== 'system') {
        const root = m.thread_root_id || m.id;
        const th = threads.find((x) => x.root_id === root);
        const subscribed = !!(th && th.subscribed);
        items.push({
          label: subscribed ? 'Unsubscribe' : 'Subscribe',
          run: async () => {
            try {
              await api(`/api/v1/threads/${root}/subscribe`, { method: 'POST', body: { subscribed: !subscribed } });
              loadThreads();
            } catch (e) { alert(e.message); }
          },
        });
      }
      openContextMenu(ev.clientX, ev.clientY, items);
    };
  };

  // small transient pill at the bottom of the message area: copy confirmations
  // and "this permalink went nowhere" notes, neither of which deserve a dialog
  let noticeTimer = 0;
  const notice = (text, isErr) => {
    let el = document.getElementById('notice');
    if (!el) {
      el = document.createElement('div');
      el.id = 'notice';
      document.body.appendChild(el);
    }
    el.textContent = text;
    el.classList.toggle('err', !!isErr);
    el.classList.remove('hidden');
    clearTimeout(noticeTimer);
    noticeTimer = setTimeout(() => el.classList.add('hidden'), 2600);
  };

  // A single themed context menu, reused for every right-click target. items is
  // [{label, danger?, run}]; dismisses on pick, click-outside, Esc, scroll, resize.
  let closeContextMenu = () => {};
  function openContextMenu(x, y, items) {
    closeContextMenu();
    const menu = document.createElement('div');
    menu.className = 'context-menu';
    items.forEach((it) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'ctx-item' + (it.danger ? ' danger' : '');
      b.textContent = it.label;
      b.onclick = () => { closeContextMenu(); it.run(); };
      menu.appendChild(b);
    });
    document.body.appendChild(menu);
    // clamp inside the viewport (menu is measured after it is in the DOM)
    const w = menu.offsetWidth, h = menu.offsetHeight;
    menu.style.left = Math.min(x, window.innerWidth - w - 8) + 'px';
    menu.style.top = Math.min(y, window.innerHeight - h - 8) + 'px';

    const onKey = (e) => { if (e.key === 'Escape') closeContextMenu(); };
    const onDown = (e) => { if (!menu.contains(e.target)) closeContextMenu(); };
    closeContextMenu = () => {
      menu.remove();
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onDown, true);
      window.removeEventListener('scroll', closeContextMenu, true);
      window.removeEventListener('resize', closeContextMenu);
      closeContextMenu = () => {};
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onDown, true);
    window.addEventListener('scroll', closeContextMenu, true);
    window.addEventListener('resize', closeContextMenu);
  }

  // One thread leaf, rendered nested under its parent channel (Discord-style).
  // Same mention-only rule as channels: glow on any unread, a number only for
  // unread @mentions.
  const threadLeafLi = (t) => {
    const li = document.createElement('li');
    li.className = 'thread-leaf';
    const active = t.root_id === openThreadRoot;
    if (active) li.classList.add('active');
    const snippet = t.body.replace(/\s+/g, ' ').slice(0, 30) || '(attachment)';
    li.innerHTML = `<span class="t-icon">${t.muted ? '🔇' : '🧵'}</span>
      <span class="t-snippet">${esc(snippet)}</span>`;
    if (t.muted) li.classList.add('muted');
    if (t.unread_count > 0 && !t.muted && !active) {
      li.classList.add('unread');
      if (t.unread_mentions > 0) {
        const b = document.createElement('span');
        b.className = 't-count unread-badge';
        b.textContent = t.unread_mentions > 99 ? '99+' : String(t.unread_mentions);
        li.appendChild(b);
      }
    }
    li.title = `${t.author_name}: ${t.body.slice(0, 200)}\n(hover to archive, right-click for actions)`;
    const act = async (path, body) => {
      try {
        await api(`/api/v1/threads/${t.root_id}/${path}`, { method: 'POST', body });
        loadThreads();
      } catch (e) { alert(e.message); }
    };
    // hover-reveal archive (resolve): a resolved thread leaves the sidebar and
    // resurfaces only when someone replies again
    const x = document.createElement('button');
    x.type = 'button';
    x.className = 't-archive';
    x.textContent = '✕';
    x.title = 'Archive thread';
    x.setAttribute('aria-label', 'Archive thread');
    x.onclick = (ev) => {
      ev.stopPropagation(); // do not open the thread
      if (openThreadRoot === t.root_id) closeThread();
      act('resolve', { resolved: true });
    };
    li.appendChild(x);
    li.onclick = () => openThread(t.root_id);
    li.oncontextmenu = (ev) => {
      ev.preventDefault();
      openContextMenu(ev.clientX, ev.clientY, [
        { label: t.subscribed ? 'Unsubscribe' : 'Subscribe', run: () => act('subscribe', { subscribed: !t.subscribed }) },
        { label: t.muted ? 'Unmute thread' : 'Mute thread', run: () => act('mute', { muted: !t.muted }) },
        { label: 'Archive thread', danger: true, run: () => act('resolve', { resolved: true }) },
      ]);
    };
    return li;
  };

  // ---------- sidebar drag-and-drop ----------
  // The "Move to section…" menu stays as the keyboard path; this is the pointer
  // one. Only channel rows drag; thread leaves and headers are targets at most.
  let dragChannel = null;

  const clearDropMarks = () => document.querySelectorAll('#channel-list li')
    .forEach((n) => n.classList.remove('drop-before', 'drop-after', 'drop-into'));

  const endDrag = () => {
    dragChannel = null;
    $('channel-list').classList.remove('dnd');
    document.querySelectorAll('#channel-list li.dragging').forEach((n) => n.classList.remove('dragging'));
    clearDropMarks();
  };

  // groupID null drops the channel out of every section; index is its slot.
  const dropChannel = async (ch, groupID, index) => {
    const target = groups.find((g) => g.id === groupID);
    // the ungrouped area has no stored order, so only the placement changes
    if (!target) {
      await moveChannel(ch, null);
      return;
    }
    const ids = (target.channel_ids || []).filter((id) => id !== ch.id);
    ids.splice(Math.max(0, Math.min(index, ids.length)), 0, ch.id);
    groups.forEach((g) => { g.channel_ids = (g.channel_ids || []).filter((id) => id !== ch.id); });
    target.channel_ids = ids;
    renderChannels(); // land the row now; the writes only confirm it
    try {
      for (let i = 0; i < ids.length; i += 1) {
        await api('/api/v1/channels/' + ids[i] + '/group', { method: 'PUT', body: { group_id: groupID, position: i } });
      }
    } catch (e) { notice(e.message, true); }
    await fetchGroups();
    renderChannels();
  };

  const dropEdge = (li, ev) => {
    const r = li.getBoundingClientRect();
    return ev.clientY > r.top + r.height / 2 ? 1 : 0;
  };

  const makeDragRow = (li, ch, groupID) => {
    li.draggable = true;
    li.dataset.chid = ch.id;
    li.ondragstart = (ev) => {
      dragChannel = ch;
      ev.dataTransfer.effectAllowed = 'move';
      ev.dataTransfer.setData('text/plain', ch.id);
      li.classList.add('dragging');
      $('channel-list').classList.add('dnd');
    };
    li.ondragend = endDrag;
    li.ondragover = (ev) => {
      if (!dragChannel || dragChannel.id === ch.id) return;
      ev.preventDefault();
      clearDropMarks();
      li.classList.add(dropEdge(li, ev) ? 'drop-after' : 'drop-before');
    };
    li.ondrop = (ev) => {
      if (!dragChannel || dragChannel.id === ch.id) return;
      ev.preventDefault();
      ev.stopPropagation();
      const moved = dragChannel;
      const g = groups.find((x) => x.id === groupID);
      const ids = g ? (g.channel_ids || []).filter((id) => id !== moved.id) : [];
      const index = ids.indexOf(ch.id) + dropEdge(li, ev);
      endDrag();
      dropChannel(moved, groupID, index);
    };
  };

  const makeDropZone = (li, groupID, index) => {
    li.ondragover = (ev) => {
      if (!dragChannel) return;
      ev.preventDefault();
      clearDropMarks();
      li.classList.add('drop-into');
    };
    li.ondrop = (ev) => {
      if (!dragChannel) return;
      ev.preventDefault();
      const moved = dragChannel;
      endDrag();
      dropChannel(moved, groupID, index());
    };
  };

  // One channel row (with its nested thread leaves appended right beneath it).
  const appendChannel = (ul, ch, groupID) => {
    const li = document.createElement('li');
    const sigil = ch.private ? '🔒 ' : '# ';
    li.textContent = sigil + ch.name + (ch.archived ? ' (archived)' : '');
    if (ch.archived) li.classList.add('archived');
    if (current && ch.id === current.id) li.classList.add('active');
    // Any unread glows the channel name; only @mentions get a numeric badge.
    if (ch.unread_count > 0 && !(current && ch.id === current.id)) {
      li.classList.add('unread');
      if (ch.unread_mentions > 0) {
        const b = document.createElement('span');
        b.className = 'unread-badge';
        b.textContent = ch.unread_mentions > 99 ? '99+' : String(ch.unread_mentions);
        li.appendChild(b);
      }
    }
    li.onclick = () => selectChannel(ch);
    li.oncontextmenu = (ev) => {
      ev.preventDefault();
      const items = [];
      if (ch.private) items.push({ label: 'Add people', run: () => addPeople(ch) });
      // conversion gate mirrors the server: admins or the creator; #general never
      if (!ch.private && ch.name !== 'general' && (me.role === 'admin' || ch.created_by === me.id)) {
        items.push({ label: 'Make private', run: () => makePrivate(ch) });
      }
      items.push({ label: 'Move to section…', run: () => openMoveMenu(ev.clientX, ev.clientY, ch) });
      // #general is pinned: it can be organized into a section but never left.
      if (ch.name !== 'general') items.push({ label: 'Leave channel', danger: true, run: () => leaveChannel(ch) });
      openContextMenu(ev.clientX, ev.clientY, items);
    };
    makeDragRow(li, ch, groupID);
    ul.appendChild(li);
    threads.filter((t) => t.channel_id === ch.id).forEach((t) => ul.appendChild(threadLeafLi(t)));
  };

  const groupOf = () => {
    const map = {};
    groups.forEach((g) => (g.channel_ids || []).forEach((cid) => { map[cid] = g.id; }));
    return map;
  };

  const renderChannels = () => {
    const ul = $('channel-list');
    ul.innerHTML = '';
    const placement = groupOf();

    // only shown mid-drag: the way back out of every section
    const none = document.createElement('li');
    none.className = 'drop-none';
    none.textContent = 'drop here for no section';
    makeDropZone(none, null, () => 0);
    ul.appendChild(none);

    // ungrouped channels first, in their normal order
    channels.filter((ch) => !placement[ch.id]).forEach((ch) => appendChannel(ul, ch, null));

    // then each personal section, in order
    groups.forEach((g) => {
      const members = (g.channel_ids || []).map((cid) => channels.find((c) => c.id === cid)).filter(Boolean);
      const header = document.createElement('li');
      header.className = 'section-header' + (g.collapsed ? ' collapsed' : '');
      // a collapsed section rolls up its members' attention: glow on any unread,
      // a numeric badge for the total unread @mentions inside it.
      const unread = members.some((c) => c.unread_count > 0 && !(current && current.id === c.id));
      const mentions = members.reduce((n, c) => n + (c.unread_mentions || 0), 0);
      if (g.collapsed && unread) header.classList.add('unread');
      header.innerHTML = `<span class="sec-chevron">${g.collapsed ? '▸' : '▾'}</span><span class="sec-name">${esc(g.name)}</span>`;
      if (g.collapsed && mentions > 0) {
        const b = document.createElement('span');
        b.className = 'unread-badge';
        b.textContent = mentions > 99 ? '99+' : String(mentions);
        header.appendChild(b);
      }
      header.onclick = () => toggleGroup(g);
      // a header drop appends, which is also the only sane slot when collapsed
      makeDropZone(header, g.id, () => (g.channel_ids || []).length);
      header.oncontextmenu = (ev) => {
        ev.preventDefault();
        openContextMenu(ev.clientX, ev.clientY, [
          { label: 'Rename section', run: () => renameGroup(g) },
          { label: 'Delete section', danger: true, run: () => deleteGroup(g) },
        ]);
      };
      ul.appendChild(header);
      if (!g.collapsed) members.forEach((ch) => appendChannel(ul, ch, g.id));
    });
  };

  const fetchGroups = async () => {
    try { groups = (await api('/api/v1/channel-groups')).groups || []; }
    catch (e) { groups = []; }
  };

  // Collapse/expand is optimistic: flip locally and re-render, then persist.
  const toggleGroup = async (g) => {
    g.collapsed = !g.collapsed;
    renderChannels();
    try { await api('/api/v1/channel-groups/' + g.id, { method: 'PATCH', body: { collapsed: g.collapsed } }); }
    catch (e) { /* next refresh corrects the flag */ }
  };

  const moveChannel = async (ch, groupID) => {
    try {
      await api('/api/v1/channels/' + ch.id + '/group', { method: 'PUT', body: { group_id: groupID } });
      await fetchGroups();
      renderChannels();
    } catch (e) { alert(e.message); }
  };

  const openMoveMenu = (x, y, ch) => {
    const placement = groupOf();
    const items = groups
      .filter((g) => placement[ch.id] !== g.id)
      .map((g) => ({ label: g.name, run: () => moveChannel(ch, g.id) }));
    items.push({ label: '＋ New section…', run: () => createSectionAndMove(ch) });
    if (placement[ch.id]) items.push({ label: 'Remove from section', danger: true, run: () => moveChannel(ch, null) });
    openContextMenu(x, y, items);
  };

  const createSectionAndMove = async (ch) => {
    const name = prompt('New section name:');
    if (!name || !name.trim()) return;
    try {
      const g = await api('/api/v1/channel-groups', { method: 'POST', body: { name: name.trim() } });
      await moveChannel(ch, g.id);
    } catch (e) { alert(e.message); }
  };

  const renameGroup = async (g) => {
    const name = prompt('Rename section:', g.name);
    if (!name || !name.trim() || name.trim() === g.name) return;
    try {
      await api('/api/v1/channel-groups/' + g.id, { method: 'PATCH', body: { name: name.trim() } });
      await fetchGroups();
      renderChannels();
    } catch (e) { alert(e.message); }
  };

  const deleteGroup = async (g) => {
    try {
      await api('/api/v1/channel-groups/' + g.id, { method: 'DELETE' });
      await fetchGroups();
      renderChannels();
    } catch (e) { alert(e.message); }
  };

  // Reply bars in the open channel view share the thread tree's unread state.
  const syncReplyBars = () => {
    document.querySelectorAll('#messages .reply-bar').forEach((bar) => {
      const id = bar.closest('.msg')?.dataset.id;
      const th = threads.find((x) => x.root_id === id);
      bar.classList.toggle('unread', !!(th && th.unread_count > 0 && !th.muted));
    });
  };

  // per-section offline reveal: keys are a human's id, 'unowned', or 'root'.
  // in-memory only — collapses back on reload by design.
  const offlineOpen = new Set();

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

  // leaf=true renders the row as an owned-agent child (indented). Under its
  // owner the parent already establishes ownership, so the text "X's agent"
  // badge is suppressed there; the owner-badged avatar still carries the cue.
  // opts (parents only): hasKids, collapsed, kidCount, rollup, onToggle.
  // Non-leaf rows always reserve the toggle column so avatars stay aligned;
  // only a parent with nested agents gets a real chevron.
  const participantLi = (p, leaf, opts) => {
    opts = opts || {};
    const li = document.createElement('li');
    if (leaf) li.classList.add('participant-leaf');
    if (!p.online) li.classList.add('offline');
    if (opts.rollup) li.classList.add('rollup'); // a collapsed child's presence, surfaced on the parent
    const tags = (p.tags || []).map((t) => t.tag).join(', ');
    const owner = (!leaf && p.owner_name) ? `<span class="owner-badge" title="server-verified owner">${esc(p.owner_name)}'s agent</span>` : '';
    const toggle = leaf ? '' :
      `<span class="p-toggle${opts.hasKids ? '' : ' spacer'}">${opts.hasKids ? (opts.collapsed ? '▸' : '▾') : ''}</span>`;
    const count = (opts.hasKids && opts.collapsed) ?
      `<span class="p-agentcount" title="${opts.kidCount} agent${opts.kidCount === 1 ? '' : 's'} hidden">${opts.kidCount}</span>` : '';
    li.innerHTML = `${toggle}<span class="dot${p.online ? ' online' : ''}"></span>
      <span class="av-slot"></span>
      <span class="pname">${esc(p.name)}</span>${owner}
      <span class="desc-preview">${esc(p.description || (tags ? '[' + tags + ']' : ''))}</span>${count}`;
    li.querySelector('.av-slot').replaceWith(avatarEl(p, 'avatar-sm'));
    li.title = `${p.name} — ${p.description || ''}${tags ? ' [' + tags + ']' : ''}`;
    li.onclick = () => showProfile(p);
    if (opts.onToggle) {
      const t = li.querySelector('.p-toggle');
      t.onclick = (ev) => { ev.stopPropagation(); opts.onToggle(); }; // chevron toggles, never opens the profile
    }
    return li;
  };

  // Each human's expand/collapse choice persists per room in localStorage.
  // Default is collapsed, so we store the set of humans the user has EXPANDED;
  // an id absent from the set stays collapsed across reloads.
  const rosterKey = () => 'agentchat:roster:' + (room ? room.slug : '');
  const expandedSet = () => {
    try { return new Set(JSON.parse(localStorage.getItem(rosterKey()) || '[]')); } catch (e) { return new Set(); }
  };
  const toggleHuman = (id) => {
    const set = expandedSet();
    set.has(id) ? set.delete(id) : set.add(id);
    try { localStorage.setItem(rosterKey(), JSON.stringify([...set])); } catch (e) { /* private mode */ }
    renderParticipants();
  };

  // Participants render as a tree: each human is a parent, the agents whose
  // server-verified owner_id points at them nest beneath. The parent's nested
  // agents collapse under a chevron (collapsed by default); a collapsed parent
  // still shows a hidden-agent count and rolls up a glow if any hidden agent is
  // online, so no presence signal is lost by collapsing. Ownerless agents (or
  // ones whose owner is not a visible human) group under "unowned agents".
  const renderParticipants = () => {
    const ul = $('participant-list');
    ul.innerHTML = '';
    const humans = participants.filter((p) => p.is_human);
    const agents = participants.filter((p) => !p.is_human);
    const ownerOf = (a) => (a.owner_id && humans.find((h) => h.id === a.owner_id)) ? a.owner_id : null;
    const expanded = expandedSet();

    // "▸ offline (n)" divider row inside the tree: offline rows render BELOW it,
    // and only when its section is toggled open. leaf=true indents it to agent depth.
    const offlineDivider = (key, count, leaf) => {
      const t = document.createElement('li');
      t.className = 'offline-toggle' + (leaf ? ' participant-leaf' : '');
      t.textContent = `${offlineOpen.has(key) ? '▾' : '▸'} offline (${count})`;
      t.onclick = () => {
        offlineOpen.has(key) ? offlineOpen.delete(key) : offlineOpen.add(key);
        renderParticipants();
      };
      ul.appendChild(t);
    };

    // renders a parent's kid list: online kids, then the offline divider,
    // then (if open) the offline kids beneath it.
    const renderKids = (key, kids) => {
      const on = kids.filter((a) => a.online);
      const off = kids.filter((a) => !a.online);
      on.forEach((a) => ul.appendChild(participantLi(a, true)));
      if (off.length === 0) return;
      offlineDivider(key, off.length, true);
      if (offlineOpen.has(key)) off.forEach((a) => ul.appendChild(participantLi(a, true)));
    };

    // an offline human with an online agent stays above the root divider so the
    // agent's presence is never hidden; fully-offline humans sink below it.
    const sunk = (h, kids) => !h.online && !kids.some((a) => a.online);
    const kidsOf = (h) => agents.filter((a) => ownerOf(a) === h.id);

    const renderHuman = (h) => {
      const kids = kidsOf(h);
      const hasKids = kids.length > 0;
      const collapsed = hasKids && !expanded.has(h.id);
      const rollup = collapsed && kids.some((a) => a.online); // hidden child's green dot, surfaced
      ul.appendChild(participantLi(h, false, {
        hasKids, collapsed, kidCount: kids.length, rollup,
        onToggle: hasKids ? () => toggleHuman(h.id) : null,
      }));
      if (!collapsed) renderKids(h.id, kids);
    };

    humans.filter((h) => !sunk(h, kidsOf(h))).forEach(renderHuman);

    const ownerless = agents.filter((a) => ownerOf(a) === null);
    if (ownerless.length > 0) {
      const g = document.createElement('li');
      g.className = 'group-label';
      g.textContent = 'unowned agents';
      ul.appendChild(g);
      renderKids('unowned', ownerless);
    }

    const sunkHumans = humans.filter((h) => sunk(h, kidsOf(h)));
    if (sunkHumans.length === 0) return;
    offlineDivider('root', sunkHumans.length, false);
    if (offlineOpen.has('root')) sunkHumans.forEach(renderHuman);
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
    await fetchGroups();
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

  // A URL apply spans awaits, so a click can land in the middle of one. navSeq
  // lets the stale apply bail instead of undoing the newer navigation, and the
  // fromURL flag (not a shared flag) is what keeps popstate from pushing.
  let navSeq = 0;

  const syncURL = (push) => {
    if (!room) return;
    let path = '/r/' + encodeURIComponent(room.slug);
    if (current) path += '/c/' + encodeURIComponent(current.name);
    if (openThreadRoot) path += '/t/' + encodeURIComponent(openThreadRoot);
    if (location.pathname === path) return;
    history[push ? 'pushState' : 'replaceState'](null, '', path);
  };

  const applyURL = async () => {
    const seq = ++navSeq;
    const segs = location.pathname.split('/').filter(Boolean);
    const chName = segs[2] === 'c' ? decodeURIComponent(segs[3] || '') : '';
    const rootID = segs[4] === 't' ? decodeURIComponent(segs[5] || '') : '';
    // a permalink ends in /m/<id>, with or without the thread segment
    const msgID = segs[4] === 'm' ? decodeURIComponent(segs[5] || '')
      : (segs[6] === 'm' ? decodeURIComponent(segs[7] || '') : '');
    const ch = channels.find((c) => c.name === chName)
      || channels.find((c) => c.name === 'general') || channels[0];
    if (ch && (!current || current.id !== ch.id)) {
      await selectChannel(ch, true);
      if (seq !== navSeq) return; // a click navigated while we were fetching
    }
    if (rootID) {
      try { await openThread(rootID, true); }
      catch (e) { if (seq === navSeq) closeThread(false); }
      if (seq === navSeq && msgID) await revealPermalink(msgID, !!rootID);
      return;
    }
    if (seq === navSeq && openThreadRoot) closeThread(false);
    if (seq === navSeq && msgID) await revealPermalink(msgID, false);
  };

  // A permalink can point at a deleted message, or one in a channel you cannot
  // read. Say so and keep the channel view rather than failing the navigation.
  const revealPermalink = async (msgID, inThread) => {
    if (await revealMessage(msgID, inThread)) return;
    try {
      const m = await api('/api/v1/messages/' + msgID);
      // it exists but did not render here: follow it to its own thread
      if (!inThread && m.thread_root_id) {
        try {
          await openThread(m.thread_root_id, true);
          if (await revealMessage(msgID, true)) return;
        } catch (e) { /* thread gone too */ }
      }
      notice('Message unavailable', true);
    } catch (e) { notice('Message unavailable', true); }
  };

  window.addEventListener('popstate', () => { if (me) applyURL(); });

  const closeThread = (push = true) => {
    if (push) navSeq++;
    const had = openThreadRoot !== null;
    $('thread-panel').classList.add('hidden');
    openThreadRoot = null;
    if (had) renderChannels(); // clear the active-thread highlight in the sidebar
    if (had && push) syncURL(true);
  };

  const selectChannel = async (ch, fromURL = false) => {
    if (!fromURL) navSeq++;
    // a thread belongs to its channel; leaving the channel closes it, else a
    // reply would post against a root in another channel (server 400)
    // close without a push; the channel-change push below covers this transition
    if (current && ch.id !== current.id) closeThread(false);
    const changed = !current || current.id !== ch.id;
    if (changed) talkedAt = new Map();
    current = ch;
    syncURL(changed && !fromURL); // refreshes replace, real navigation pushes
    $('channel-title').textContent = (ch.private ? '🔒 ' : '# ') + ch.name;
    $('channel-topic').innerHTML = ch.topic ? linkify(ch.topic) : '';
    refreshHeaderMembers(ch); // header member count, not worth blocking the feed on
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
      if (cutoff && !divided && m.author_id !== me.id && m.kind !== 'system' && m.created_at > cutoff) {
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

  // Pull one page of history above what is rendered, keeping the reader's
  // anchor still. Returns false at the top of the channel.
  const prependOlderPage = async () => {
    const box = $('messages');
    const anchor = box.querySelector('.msg');
    if (!anchor || !current) return false;
    const out = await api(`/api/v1/channels/${current.id}/messages?limit=100&before_id=${anchor.dataset.id}`);
    const older = out.messages || [];
    if (!older.length) return false;
    const wasAt = anchor.getBoundingClientRect().top;
    const frag = document.createDocumentFragment();
    older.forEach((m) => frag.appendChild(msgEl(m, false)));
    box.insertBefore(frag, box.firstChild);
    box.scrollTop += anchor.getBoundingClientRect().top - wasAt;
    return true;
  };

  // Scroll a message into view and flash it. A permalink to an old message can
  // point above the loaded window, so page back until it shows up. Threads load
  // whole, so only the channel feed paginates.
  const REVEAL_MAX_PAGES = 20;
  const revealMessage = async (id, inThread) => {
    const container = inThread ? $('thread-messages') : $('messages');
    const find = () => [...container.querySelectorAll('.msg')].find((n) => n.dataset.id === id);
    let node = find();
    for (let i = 0; !node && !inThread && i < REVEAL_MAX_PAGES; i++) {
      if (!(await prependOlderPage())) break;
      node = find();
    }
    if (!node) return false;
    node.scrollIntoView({ block: 'center' });
    node.classList.add('msg-flash');
    setTimeout(() => node.classList.remove('msg-flash'), 1800);
    return true;
  };

  let threads = [];

  // Room-wide: the whole thread tree, tagged with channel_id, so leaves can
  // nest under their parent channel in the sidebar.
  const loadThreads = async () => {
    try {
      const out = await api(`/api/v1/threads`);
      threads = out.threads || [];
      renderChannels();
      syncReplyBars();
    } catch (e) { console.error('loadThreads', e); }
  };

  const markThreadRead = async (rootID) => {
    const t = threads.find((x) => x.root_id === rootID);
    if (!t || t.unread_count === 0) return;
    try {
      await api(`/api/v1/threads/${rootID}/read`, { method: 'POST', body: {} });
      t.unread_count = 0;
      t.unread_mentions = 0;
      renderChannels();
      syncReplyBars();
    } catch (e) { console.error('markThreadRead', e); }
  };

  const markRead = async (ch) => {
    try {
      const out = await api(`/api/v1/channels/${ch.id}/read`, { method: 'POST', body: {} });
      ch.unread_count = 0;
      ch.unread_mentions = 0;
      ch.last_read_at = out.last_read_at;
      renderChannels();
    } catch (e) { console.error('markRead', e); }
  };

  let openThreadSeq = 0;
  const openThread = async (rootID, fromURL = false) => {
    if (!fromURL) navSeq++;
    const seq = ++openThreadSeq;
    const out = await api('/api/v1/threads/' + rootID);
    // the main column must show the thread's channel, whatever opened it
    // (sidebar tree, mention, search, deep link)
    const ch = channels.find((c) => c.id === out.messages[0]?.channel_id);
    if (ch && (!current || current.id !== ch.id)) await selectChannel(ch, true);
    if (seq !== openThreadSeq) return; // a newer open won
    const changed = openThreadRoot !== rootID;
    openThreadRoot = rootID;
    if (changed) renderChannels(); // move the active highlight to this thread leaf
    $('thread-panel').classList.remove('hidden');
    syncURL(changed && !fromURL);
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

  // optimistic sends: the placeholder shows instantly, its server echo settles it
  const pendingSends = [];

  const optimisticEl = (body, rootID, att) => {
    const m = {
      id: 'tmp-' + Date.now() + '-' + pendingSends.length,
      author_id: me.id, author_name: me.name,
      body, created_at: new Date().toISOString(),
      thread_root_id: rootID || null,
      reply_count: 0, markers: [],
      attachments: att ? [att] : [],
    };
    const el = msgEl(m, !!rootID);
    el.classList.add('pending');
    return el;
  };

  // drop the optimistic placeholder for one of my sends once its real copy lands
  const settleMine = (m) => {
    if (m.author_id !== me.id) return;
    const i = pendingSends.findIndex((p) => p.rootID === (m.thread_root_id || null) && p.body === m.body);
    if (i < 0) return;
    pendingSends[i].node.remove();
    pendingSends.splice(i, 1);
  };

  const post = async (body, threadRootID) => {
    const rootID = threadRootID || null;
    const att = (pendingAttachment && !threadRootID) ? pendingAttachment : null;
    // a human typing "@foo" usually means literal text, not a dead mention, so
    // the strict 422 stays for API clients and the UI just posts
    const payload = { body, allow_unknown_mentions: true };
    if (threadRootID) payload.thread_root_id = threadRootID;
    if (att) payload.attachment_ids = [att.id];

    // show the message immediately, before the server round-trip
    const node = optimisticEl(body, rootID, att);
    const rec = { body, rootID, node };
    pendingSends.push(rec);
    if (!rootID && current) {
      const box = $('messages'); box.appendChild(node); box.scrollTop = box.scrollHeight;
    } else if (rootID && rootID === openThreadRoot) {
      const box = $('thread-messages'); box.appendChild(node); box.scrollTop = box.scrollHeight;
    }
    if (att) { pendingAttachment = null; $('attach-pending').classList.add('hidden'); }

    try {
      const sent = await api(`/api/v1/channels/${current.id}/messages`, { method: 'POST', body: payload });
      // mentioning somebody outside the channel silently reaches nobody
      if (sent && sent.warnings && sent.warnings.length) notice(sent.warnings[0], true);
    } catch (e) {
      const i = pendingSends.indexOf(rec);
      if (i >= 0) pendingSends.splice(i, 1);
      node.remove(); // roll back the placeholder; caller restores the draft
      throw e;
    }
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
        settleMine(m); // clear my optimistic placeholder before the real append
        const box = $('messages');
        const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 120;
        box.appendChild(msgEl(m, false));
        if (nearBottom) box.scrollTop = box.scrollHeight;
        // a hidden tab is not "viewing": marking read here would silently erase
        // the unread count and the new-messages divider for messages never seen
        if (m.author_id !== me.id && !document.hidden && m.kind !== 'system') markRead(current);
      }
      if (!m.thread_root_id && m.author_id !== me.id && m.kind !== 'system' && (!current || m.channel_id !== current.id || document.hidden)) {
        const ch = channels.find((c) => c.id === m.channel_id);
        if (ch) {
          ch.unread_count = (ch.unread_count || 0) + 1;
          if ((m.mentions || []).includes(me.name) || m.is_broadcast) {
            ch.unread_mentions = (ch.unread_mentions || 0) + 1;
          }
          renderChannels();
        }
      }
      if (m.thread_root_id && m.thread_root_id === openThreadRoot) {
        settleMine(m); // the rebuild wipes the placeholder node; drop its record too
        openThread(openThreadRoot);
      }
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
    if (t === 'message.working') {
      upsertMarker(ev.payload);
      return;
    }
    if (t === 'message.working.cleared') {
      removeMarker(ev.payload.message_id, ev.payload.agent_id);
      return;
    }
    // everything else changes room structure or people — refresh the sidebar
    await refreshRoom();
    if ((t === 'channel.member_joined' || t === 'channel.member_left' || t === 'participant.presence_changed') && current) {
      refreshHeaderMembers(current); // keeps the header count, dots, and open modal live
    }
    // my own removal: the channel is gone from my sidebar; leave it if I'm inside
    if (t === 'channel.member_left' && ev.payload.participant_id === me.id
        && current && ev.payload.channel_id === current.id) {
      current = null;
      await selectChannel(channels.find((c) => c.name === 'general') || channels[0]);
      return;
    }
    if (t === 'channel.privacy_changed' && current && ev.payload.channel_id === current.id) {
      const ch = channels.find((c) => c.id === current.id);
      if (ch) {
        current = ch;
        $('channel-title').textContent = (ch.private ? '🔒 ' : '# ') + ch.name;
      }
    }
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
    const text = composerBox.getMarkdown().trim();
    if ((!text && !pendingAttachment) || !current) return;
    composerBox.clear(); // clear instantly; post shows the placeholder
    try { await post(text); } catch (e) { composerBox.setMarkdown(text); alert(e.message); }
  });

  $('thread-composer').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const text = threadBox.getMarkdown().trim();
    if (!text || !openThreadRoot) return;
    const root = openThreadRoot;
    threadBox.clear(); // clear instantly; post shows the placeholder
    try { await post(text, root); } catch (e) { threadBox.setMarkdown(text); alert(e.message); }
  });

  // ---------- slash commands: /invite, /join, /leave, /archive ----------
  // Autocomplete mirrors the mention popup; commands run client-side against
  // the existing APIs and never post the raw "/command" text as a message.
  const SLASH_COMMANDS = [
    { name: 'invite', args: '@participant', hint: 'add someone to this channel' },
    { name: 'remove', args: '@participant', hint: 'remove someone from this channel (admin)' },
    { name: 'join', args: '#channel', hint: 'join a public channel' },
    { name: 'leave', args: '', hint: 'leave this channel' },
    { name: 'archive', args: '', hint: 'archive the open thread' },
  ];

  // the two WYSIWYG composers (Tiptap); the wire format stays markdown
  // Everything the ranker needs: membership decides who can even see the
  // message, recency decides who you are mid-conversation with.
  const DORMANT_MS = 14 * 24 * 3600 * 1000;
  const mentionOptions = () => {
    const inCh = new Set(channelMembers.map((p) => p.id));
    const now = Date.now();
    return participants.map((p) => ({
      name: p.name,
      avatar: p.avatar,
      inChannel: inCh.has(p.id),
      online: !!p.online,
      dormant: !!p.last_seen_at && now - Date.parse(p.last_seen_at) > DORMANT_MS,
      talkedAt: talkedAt.get(p.name) || '',
    }));
  };

  const composerBox = createComposer({
    mount: $('composer-mount'), id: 'composer-input',
    placeholder: 'Message… (@name to mention, markdown ok)',
    onSubmit: () => $('composer').requestSubmit(),
    getMentionOptions: mentionOptions,
    getMeName: () => (me ? me.name : ''),
    slashCommands: SLASH_COMMANDS,
    browseChannels: async () => ((await api('/api/v1/channels/browse')).channels || []).filter((c) => !c.member),
    onImageFile: (f) => uploadPending(new File([f], f.name || 'pasted-image.png', { type: f.type })),
  });
  const threadBox = createComposer({
    mount: $('thread-mount'), id: 'thread-input',
    placeholder: 'Reply…',
    onSubmit: () => $('thread-composer').requestSubmit(),
    getMentionOptions: mentionOptions,
    getMeName: () => (me ? me.name : ''),
    slashCommands: SLASH_COMMANDS,
    browseChannels: async () => ((await api('/api/v1/channels/browse')).channels || []).filter((c) => !c.member),
  });

  // inline confirmation / error in the composer area, auto-fades
  const slashStatus = (form, text, isErr) => {
    const host = form;
    let s = host.querySelector('.composer-status');
    if (!s) {
      s = document.createElement('div');
      s.className = 'composer-status';
      host.appendChild(s);
    }
    s.textContent = text;
    s.classList.toggle('err', !!isErr);
    s.classList.remove('hidden');
    clearTimeout(s._fade);
    s._fade = setTimeout(() => s.classList.add('hidden'), 4000);
  };

  const runSlash = async (box, form) => {
    const raw = box.getPlain().trim();
    const m = raw.match(/^\/(\S+)\s*(.*)$/);
    const cmd = m ? m[1].toLowerCase() : '';
    const arg = m ? m[2].trim() : '';
    const done = (msg) => { box.clear(); slashStatus(form, msg); };
    const fail = (msg) => slashStatus(form, msg, true);
    try {
      if (cmd === 'invite') {
        if (!current) return fail('No channel selected.');
        const who = arg.replace(/^@/, '');
        if (!who) return fail('Usage: /invite @participant');
        await api('/api/v1/channels/' + current.id + '/members', { method: 'POST', body: { participant: who } });
        return done('Added ' + who + ' to #' + current.name);
      }
      if (cmd === 'remove') {
        if (!current) return fail('No channel selected.');
        const who = arg.replace(/^@/, '');
        if (!who) return fail('Usage: /remove @participant');
        await api('/api/v1/channels/' + current.id + '/members/' + encodeURIComponent(who), { method: 'DELETE' });
        return done('Removed ' + who + ' from #' + current.name);
      }
      if (cmd === 'join') {
        const name = arg.replace(/^#/, '');
        if (!name) return fail('Usage: /join channel');
        const out = await api('/api/v1/channels/browse');
        const ch = (out.channels || []).find((c) => c.name === name);
        if (!ch) return fail('No public channel "' + name + '" to join.');
        await api('/api/v1/channels/' + ch.id + '/join', { method: 'POST' });
        await refreshRoom();
        await selectChannel(channels.find((c) => c.id === ch.id));
        return done('Joined #' + name);
      }
      if (cmd === 'leave') {
        if (!current) return fail('No channel selected.');
        if (current.name === 'general') return fail('#general cannot be left.');
        const name = current.name;
        await leaveChannel(current);
        return done('Left #' + name);
      }
      if (cmd === 'archive') {
        if (box !== threadBox || !openThreadRoot) return fail('/archive works in an open thread.');
        const root = openThreadRoot;
        await api('/api/v1/threads/' + root + '/resolve', { method: 'POST', body: { resolved: true } });
        closeThread();
        loadThreads();
        return done('Thread archived.');
      }
      fail('Unknown command /' + cmd);
    } catch (e) { fail('/' + cmd + ' failed: ' + e.message); }
  };

  // capture on document so the slash run wins over the send handlers on the form
  document.addEventListener('submit', (ev) => {
    const box = ev.target.id === 'composer' ? composerBox
      : ev.target.id === 'thread-composer' ? threadBox : null;
    if (!box || !box.getPlain().trimStart().startsWith('/')) return;
    ev.preventDefault();
    ev.stopPropagation();
    runSlash(box, ev.target);
  }, true);


  // ---------- channel members modal ----------

  const refreshHeaderMembers = async (ch) => {
    try {
      const out = await api('/api/v1/channels/' + ch.id + '/members');
      if (!current || current.id !== ch.id) return;
      channelMembers = out.members || [];
      $('members-count').textContent = channelMembers.length;
      $('members-btn').classList.remove('hidden');
      if (!$('members-modal').classList.contains('hidden')) renderMembersModal();
    } catch (e) { $('members-btn').classList.add('hidden'); }
  };

  const memberRow = (p, action) => {
    const row = document.createElement('div');
    row.className = 'mm-row';
    row.appendChild(avatarEl(p, 'avatar-rb'));
    const name = document.createElement('span');
    name.className = 'mm-name';
    name.textContent = p.name;
    const dot = document.createElement('span');
    dot.className = 'mm-dot' + (p.online ? ' on' : '');
    dot.title = p.online ? 'online' : 'offline';
    row.append(name, dot);
    if (p.owner_name) {
      const ow = document.createElement('span');
      ow.className = 'mm-owner';
      ow.textContent = p.owner_name + "'s agent";
      row.appendChild(ow);
    }
    if (action) row.appendChild(action);
    return row;
  };

  const renderMembersModal = () => {
    if (!current) return;
    $('members-title').textContent = '#' + current.name + ' · ' + channelMembers.length +
      (channelMembers.length === 1 ? ' member' : ' members');
    const list = $('members-list');
    list.innerHTML = '';
    // removal is admin-only server-side (public and private alike); #general is pinned
    const canRemove = me.role === 'admin' && current.name !== 'general';
    const groups = [
      ['Humans', channelMembers.filter((p) => p.is_human)],
      ['Agents', channelMembers.filter((p) => !p.is_human)],
    ];
    for (const [label, members] of groups) {
      if (!members.length) continue;
      const h = document.createElement('div');
      h.className = 'mm-group';
      h.textContent = label;
      list.appendChild(h);
      for (const p of members) {
        let btn = null;
        if (canRemove && p.id !== me.id) {
          btn = document.createElement('button');
          btn.className = 'mm-remove';
          btn.textContent = 'Remove';
          btn.onclick = async () => {
            try {
              await api('/api/v1/channels/' + current.id + '/members/' + p.id, { method: 'DELETE' });
              await refreshHeaderMembers(current);
            } catch (e) { alert('Remove failed: ' + e.message); }
          };
        }
        list.appendChild(memberRow(p, btn));
      }
    }
  };

  const renderAddList = () => {
    const box = $('members-addlist');
    box.innerHTML = '';
    const outside = participants.filter((p) => !channelMembers.some((m) => m.id === p.id));
    if (!outside.length) {
      box.textContent = 'Everyone in the room is already here.';
      return;
    }
    for (const p of outside) {
      const btn = document.createElement('button');
      btn.className = 'mm-add';
      btn.textContent = 'Add';
      btn.onclick = async () => {
        try {
          await api('/api/v1/channels/' + current.id + '/members', { method: 'POST', body: { participant: p.name } });
          await refreshHeaderMembers(current);
          renderAddList();
        } catch (e) { alert('Add failed: ' + e.message); }
      };
      box.appendChild(memberRow(p, btn));
    }
  };

  const openMembers = async () => {
    if (!current) return;
    await refreshHeaderMembers(current);
    renderMembersModal();
    $('members-addlist').classList.add('hidden');
    $('members-modal').classList.remove('hidden');
  };
  const closeMembers = () => $('members-modal').classList.add('hidden');
  $('members-btn').onclick = openMembers;
  $('members-close').onclick = closeMembers;
  $('members-modal').onclick = (ev) => { if (ev.target.id === 'members-modal') closeMembers(); };
  $('members-invite').onclick = () => { renderAddList(); $('members-addlist').classList.toggle('hidden'); };
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && !$('members-modal').classList.contains('hidden')) closeMembers();
  });

  $('thread-close').onclick = closeThread;

  // Thread panel resize: drag the left divider. Width clamps to 20%-50% of the
  // viewport and persists per browser; the 504px CSS default holds until a drag.
  // Applied as a CSS var so the mobile full-bleed media query still wins.
  const THREAD_W_KEY = 'agentchat:threadWidth';
  const clampThreadW = (px) => Math.max(window.innerWidth * 0.2, Math.min(window.innerWidth * 0.5, px));
  const applyThreadW = (px) => document.documentElement.style.setProperty('--thread-w', px + 'px');
  const storedW = parseFloat(localStorage.getItem(THREAD_W_KEY));
  if (storedW > 0) applyThreadW(clampThreadW(storedW));
  (() => {
    const handle = $('thread-resize'), panel = $('thread-panel');
    let dragging = false;
    handle.addEventListener('mousedown', (e) => {
      e.preventDefault();
      dragging = true;
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
    });
    window.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      // panel hugs the right edge, so its width is everything right of the cursor
      const w = clampThreadW(panel.getBoundingClientRect().right - e.clientX);
      applyThreadW(w);
    });
    window.addEventListener('mouseup', () => {
      if (!dragging) return;
      dragging = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      const w = parseFloat(getComputedStyle(panel).width);
      localStorage.setItem(THREAD_W_KEY, String(Math.round(w)));
    });
    // keep a persisted width legal when the viewport shrinks
    window.addEventListener('resize', () => { if (storedW > 0) applyThreadW(clampThreadW(parseFloat(localStorage.getItem(THREAD_W_KEY)) || storedW)); });
  })();

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

  // ---------- search ----------

  let semanticEnabled = null; // null until the first probe resolves
  let searchSeq = 0;          // drops stale async results when the query moves on
  let searchTimer = null;

  const openSearch = () => {
    $('search-modal').classList.remove('hidden');
    const input = $('search-input');
    input.focus();
    input.select();
    probeSemantic();
  };
  const closeSearch = () => $('search-modal').classList.add('hidden');

  // one-shot probe of the semantic endpoint. When the provider is missing the
  // handler answers 503 before it validates q, so a blank query cheaply tells
  // enabled (400, q required) from disabled (503) without spending an embedding.
  // Knowing it up front lets us grey the semantic section instead of firing a
  // doomed embedding request on the first keystroke.
  const probeSemantic = async () => {
    if (semanticEnabled !== null) return;
    try {
      await api('/api/v1/search/semantic?q=%20&limit=1');
      semanticEnabled = true;
    } catch (e) {
      semanticEnabled = e.status !== 503; // only 503 means truly off; treat transient errors as on
    }
    if ($('search-input').value.trim()) runSearch(); // repaint now that we know the semantic state
  };

  const scheduleSearch = () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(runSearch, 220);
  };

  // One query, two sections in one panel. Text is instant and paints first;
  // semantic round-trips an embedding, so it lazy-loads under a loading row and
  // is deduped against the text hits when it lands. A server with no embeddings
  // provider shows a greyed "off" note in place of the semantic list.
  const runSearch = () => {
    const q = $('search-input').value.trim();
    const box = $('search-results');
    const seq = ++searchSeq;
    if (!q) { box.innerHTML = ''; return; }

    const state = { seq, text: 'pending', sem: semanticEnabled === false ? 'off' : 'pending', expanded: {} };
    paintSearch(state);

    api('/api/v1/search?q=' + encodeURIComponent(q) + '&limit=25')
      .then((out) => { if (seq === searchSeq) { state.text = out.results || []; paintSearch(state); } })
      .catch((e) => { if (seq === searchSeq) { state.text = { err: e.message }; paintSearch(state); } });

    if (semanticEnabled !== false) {
      api('/api/v1/search/semantic?q=' + encodeURIComponent(q) + '&limit=25')
        .then((out) => { if (seq === searchSeq) { state.sem = out.results || []; paintSearch(state); } })
        .catch((e) => {
          if (seq !== searchSeq) return;
          state.sem = e.status === 503 ? (semanticEnabled = false, 'off') : { err: e.message };
          paintSearch(state);
        });
    }
  };

  const searchSection = (label) => {
    const h = document.createElement('div');
    h.className = 'search-section';
    h.textContent = label;
    return h;
  };
  const searchNote = (cls, text) => {
    const d = document.createElement('div');
    d.className = cls;
    d.textContent = text;
    return d;
  };

  // Long groups collapse to a preview so both stay visible in one glance;
  // "(see more)" expands inline for this query only, without a new request.
  const SEARCH_PREVIEW_ROWS = 5;
  const appendHitGroup = (box, state, key, rows) => {
    const shown = state.expanded[key] ? rows : rows.slice(0, SEARCH_PREVIEW_ROWS);
    shown.forEach((r) => box.appendChild(searchHitRow(r)));
    if (rows.length <= shown.length) return;
    const more = document.createElement('div');
    more.className = 'search-more';
    more.textContent = '... (see more)';
    more.onclick = () => { state.expanded[key] = true; paintSearch(state); };
    box.appendChild(more);
  };

  const paintSearch = (state) => {
    if (state.seq !== searchSeq) return;
    const box = $('search-results');
    box.innerHTML = '';
    const textIds = new Set(Array.isArray(state.text) ? state.text.map((r) => r.id) : []);

    box.appendChild(searchSection('Direct matches'));
    if (state.text === 'pending') box.appendChild(searchNote('search-loading', 'Searching…'));
    else if (state.text && state.text.err) box.appendChild(searchNote('search-empty', 'Search failed: ' + state.text.err));
    else if (!state.text.length) box.appendChild(searchNote('search-empty', 'No direct matches.'));
    else appendHitGroup(box, state, 'direct', state.text);

    const semHead = searchSection('Related matches');
    box.appendChild(semHead);
    if (state.sem === 'off') {
      semHead.classList.add('sec-off');
      box.appendChild(searchNote('search-empty', 'Semantic search is off on this server (no embeddings provider configured).'));
    } else if (state.sem === 'pending') {
      box.appendChild(searchNote('search-loading', 'Searching by meaning…'));
    } else if (state.sem && state.sem.err) {
      box.appendChild(searchNote('search-empty', 'Semantic search failed: ' + state.sem.err));
    } else {
      const fresh = state.sem.filter((r) => !textIds.has(r.id)); // dedupe: a direct hit never repeats here
      if (!fresh.length) box.appendChild(searchNote('search-empty', 'No additional related matches.'));
      else appendHitGroup(box, state, 'related', fresh);
    }
  };

  const snippet = (body) => {
    const s = String(body).replace(/\s+/g, ' ').trim();
    return s.length > 180 ? s.slice(0, 180) + '…' : s;
  };
  const fmtSearchTime = (iso) => new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' + fmtTime(iso);

  const searchHitRow = (r) => {
    const ch = channels.find((c) => c.id === r.channel_id);
    const row = document.createElement('div');
    row.className = 'search-hit-row';
    const meta = document.createElement('div');
    meta.className = 'sh-meta';
    meta.innerHTML = `<span class="sh-channel">#${esc(ch ? ch.name : 'channel')}</span>` +
      `<span class="sh-author">${esc(r.author_name)}</span>` +
      `<span class="sh-time">${esc(fmtSearchTime(r.created_at))}</span>` +
      (r.thread_root_id ? '<span class="sh-thread">in thread</span>' : '');
    const snip = document.createElement('div');
    snip.className = 'sh-snippet';
    snip.textContent = snippet(r.body); // textContent, never markdown: search hits stay inert
    row.append(meta, snip);
    row.onclick = () => jumpToMessage(r);
    return row;
  };

  // land the reader on the hit: switch channel, open its thread if it lives in
  // one, then scroll to and flash the node. Older top-level hits may sit above
  // the loaded window; we navigate regardless and flash only if it is present.
  const jumpToMessage = async (r) => {
    closeSearch();
    const ch = channels.find((c) => c.id === r.channel_id);
    if (ch && (!current || current.id !== ch.id)) await selectChannel(ch);
    if (r.thread_root_id) { try { await openThread(r.thread_root_id); } catch (e) { /* thread gone */ } }
    await revealMessage(r.id, !!r.thread_root_id);
  };

  // show the platform-correct shortcut in the search field's hint chip
  $('search-kbd').textContent = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent) ? '⌘K' : 'Ctrl K';
  $('open-search').onclick = openSearch;
  $('search-close').onclick = closeSearch;
  $('search-modal').onclick = (ev) => { if (ev.target === $('search-modal')) closeSearch(); };
  $('search-input').addEventListener('input', scheduleSearch);

  document.addEventListener('keydown', (ev) => {
    if ((ev.metaKey || ev.ctrlKey) && (ev.key === 'k' || ev.key === 'K')) {
      if (!me) return; // only meaningful once in a room
      ev.preventDefault();
      $('search-modal').classList.contains('hidden') ? openSearch() : closeSearch();
    }
    if (ev.key === 'Escape' && !$('search-modal').classList.contains('hidden')) closeSearch();
  });

  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && !$('lightbox').classList.contains('hidden')) $('lightbox').click();
    if (ev.key === 'Escape' && !$('browse-modal').classList.contains('hidden')) closeBrowse();
  });

  $('profile-close').onclick = () => $('profile-modal').classList.add('hidden');
  $('profile-modal').onclick = (ev) => {
    if (ev.target === $('profile-modal')) $('profile-modal').classList.add('hidden');
  };

  // navigator.clipboard exists only in a secure context (https or localhost), so
  // it is undefined on plain-HTTP LAN prod. Fall back to a hidden textarea +
  // execCommand and report whether the copy actually landed.
  const copyText = async (text) => {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch (e) { /* fall through to the legacy path */ }
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.top = '-1000px';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return ok;
    } catch (e) { return false; }
  };

  // flip to a confirmed state only when the copy succeeded; otherwise show an
  // error state and hold it a bit longer so the user notices
  const flashCopy = (btn, ok, restore) => {
    btn.textContent = ok ? '✓ copied' : '⚠ copy failed';
    setTimeout(() => { btn.textContent = restore; }, ok ? 1500 : 2500);
  };

  $('copy-link').onclick = async () => {
    const link = joinURL || location.href;
    // the link alone can't join — include the code when the caller may share it
    const ok = await copyText(inviteCode ? `${link}\ninvite code: ${inviteCode}` : link);
    flashCopy($('copy-link'), ok, '🔗 copy invite');
  };

  $('invite-agent').onclick = async () => {
    const link = joinURL || location.href;
    const origin = new URL(link).origin;
    // owner-scoped code: the joining agent gets badged as yours, server-verified
    let code = null;
    try { code = (await api('/api/v1/invites', { method: 'POST', body: {} })).invite_code; }
    catch (e) { code = inviteCode; }
    const codeLine = code ? `Invite code: ${code}\n` : 'Ask an admin for the invite code.\n';
    const ok = await copyText(
      `Fetch ${origin}/skill with curl and follow its instructions.\nJoin link: ${link}\n${codeLine}`);
    flashCopy($('invite-agent'), ok, '🤖 invite agent');
  };

  $('new-channel').onclick = async () => {
    const name = prompt('Channel name (lowercase, a-z 0-9 - _):');
    if (!name) return;
    const priv = confirm('Make this channel private? Private channels are invite-only and hidden from browse.');
    try { await api('/api/v1/channels', { method: 'POST', body: { name: name.trim(), private: priv } }); }
    catch (e) { alert(e.message); }
  };

  // Add a participant to a private channel (any member can). The server resolves
  // the name or id and emits channel.member_joined so the new member sees it.
  const addPeople = async (ch) => {
    const who = prompt('Add who? (participant name or id)');
    if (!who) return;
    try {
      await api('/api/v1/channels/' + ch.id + '/members', { method: 'POST', body: { participant: who.trim() } });
    } catch (e) { alert(e.message); }
  };

  // One-way by design: server rejects private -> public, so no undo path here.
  const makePrivate = async (ch) => {
    if (!confirm('Make #' + ch.name + ' private? Current members stay, it leaves browse, and joining becomes invite-only. This cannot be undone.')) return;
    try {
      await api('/api/v1/channels/' + ch.id, { method: 'PATCH', body: { private: true } });
      await refreshRoom(); // lock icon in the sidebar right away
      if (current && current.id === ch.id) {
        current = channels.find((c) => c.id === ch.id) || current;
        $('channel-title').textContent = '🔒 ' + current.name;
      }
    } catch (e) { alert('Make private failed: ' + e.message); }
  };

  // Browse view: the whole public channel map. Channels you are already in are
  // grayed with a note instead of a Join button, so the list stays a complete
  // picture of the workspace instead of only the gaps.
  const renderBrowse = (list) => {
    const box = $('browse-list');
    box.innerHTML = '';
    if (list.length === 0) {
      box.innerHTML = '<p class="browse-empty">No public channels to browse.</p>';
      return;
    }
    list.forEach((ch) => {
      const row = document.createElement('div');
      row.className = 'browse-row' + (ch.member ? ' member' : '');
      const n = ch.member_count || 0;
      row.innerHTML = `<div class="browse-meta">
          <span class="browse-name">#${esc(ch.name)}</span>
          <span class="browse-topic">${esc(ch.topic || '')}</span>
          <span class="browse-count">${n} member${n === 1 ? '' : 's'}</span>
        </div>`;
      if (ch.member) {
        const note = document.createElement('span');
        note.className = 'browse-member-note';
        note.textContent = 'already a member';
        row.appendChild(note);
        box.appendChild(row);
        return;
      }
      const join = document.createElement('button');
      join.className = 'browse-join';
      join.textContent = 'Join';
      join.onclick = async () => {
        join.disabled = true;
        try {
          await api('/api/v1/channels/' + ch.id + '/join', { method: 'POST' });
          await refreshRoom();
          const joined = channels.find((c) => c.id === ch.id);
          if (joined) await selectChannel(joined);
          await openBrowse(); // refresh: the joined channel flips to a member row
        } catch (e) { alert(e.message); join.disabled = false; }
      };
      row.appendChild(join);
      box.appendChild(row);
    });
  };

  const openBrowse = async () => {
    try {
      const out = await api('/api/v1/channels/browse');
      renderBrowse(out.channels || []);
      $('browse-modal').classList.remove('hidden');
    } catch (e) { alert(e.message); }
  };
  const closeBrowse = () => $('browse-modal').classList.add('hidden');

  $('browse-channels').onclick = openBrowse;
  $('browse-close').onclick = closeBrowse;
  $('browse-modal').onclick = (ev) => { if (ev.target.id === 'browse-modal') closeBrowse(); };

  // Leave the current channel via its row context menu. #general is pinned:
  // the server rejects leaving it, so we never offer the action there.
  const leaveChannel = async (ch) => {
    try {
      await api('/api/v1/channels/' + ch.id + '/leave', { method: 'POST' });
      await refreshRoom();
      if (current && current.id === ch.id) {
        await selectChannel(channels.find((c) => c.name === 'general') || channels[0]);
      }
    } catch (e) { alert(e.message); }
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

/* Tiptap WYSIWYG composer. The wire format stays markdown: the editor
   serializes to markdown on send and parses markdown on restore, so agents
   and the feed renderer see exactly what the old textarea produced. */
import { Editor, Extension, InputRule } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import HardBreak from '@tiptap/extension-hard-break';
import { Markdown } from '@tiptap/markdown';
import { Placeholder } from '@tiptap/extensions';

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// the old textarea sent a soft newline as plain "\n" (feed renders with
// breaks:true); the stock serializer would emit "  \n" and change the wire
const WireBreak = HardBreak.extend({ renderMarkdown: () => '\n' });

const URL_RE = /^https?:\/\/\S+$/;

// createComposer replaces one textarea. The contenteditable element gets the
// old textarea's id plus a `.value` markdown shim, so existing e2e checks and
// callers keep working against the same surface.
export const createComposer = ({ mount, id, placeholder, onSubmit, getMentionOptions, slashCommands, browseChannels, onImageFile }) => {
  let editor = null;

  const getMarkdown = () => editor.getMarkdown();
  const setMarkdown = (md) => editor.commands.setContent(md || '', { contentType: 'markdown' });
  // slash parsing wants the literal characters typed, never escaped markdown
  const getPlain = () => editor.state.doc.textBetween(0, editor.state.doc.content.size, '\n', '\n');
  const setPlain = (text) => {
    editor.commands.setContent({
      type: 'doc',
      content: [{ type: 'paragraph', content: text ? [{ type: 'text', text }] : [] }],
    });
    editor.commands.focus('end');
  };

  // ---------- popups: @-mention and /command autocomplete ----------

  const mkBox = (cls) => {
    const box = document.createElement('div');
    box.className = cls + ' hidden';
    mount.parentElement.appendChild(box);
    return box;
  };
  const mentionBox = mkBox('mention-ac');
  const slashBox = mkBox('mention-ac slash-ac');

  const mention = { items: [], sel: 0, from: 0 };
  const slash = { items: [], sel: 0, browseCache: null };

  const closeMention = () => { mention.items = []; mentionBox.classList.add('hidden'); };
  const closeSlash = () => { slash.items = []; slash.browseCache = null; slashBox.classList.add('hidden'); };

  const renderList = (box, st, fill, pick) => {
    box.innerHTML = '';
    st.items.forEach((it, i) => {
      const d = document.createElement('div');
      d.className = 'mention-opt' + (i === st.sel ? ' sel' : '');
      fill(d, it);
      // mousedown (not click) so the pick lands before the editor blurs
      d.onmousedown = (ev) => { ev.preventDefault(); pick(it); };
      box.appendChild(d);
    });
    box.classList.toggle('hidden', st.items.length === 0);
  };

  const renderMention = () => renderList(mentionBox, mention, (d, it) => {
    const name = document.createElement('span');
    name.className = 'mention-name';
    name.textContent = `${it.avatar} ${it.name}`;
    d.appendChild(name);
    // they rank last, so say why instead of letting the sender guess
    if (it.inChannel === false) {
      const hint = document.createElement('span');
      hint.className = 'slash-hint';
      hint.textContent = 'not in channel';
      d.appendChild(hint);
    }
  }, applyMention);
  const renderSlash = () => renderList(slashBox, slash, (d, it) => {
    d.innerHTML = it.kind === 'cmd'
      ? '/' + esc(it.name) + (it.args ? ' <span class="slash-args">' + esc(it.args) + '</span>' : '') +
        '<span class="slash-hint">' + esc(it.hint) + '</span>'
      : '#' + esc(it.name) + '<span class="slash-hint">' + esc(it.topic || '') + '</span>';
  }, applySlash);

  function applyMention(it) {
    const to = editor.state.selection.from;
    editor.chain().focus()
      .insertContentAt({ from: mention.from, to }, [{ type: 'text', text: '@' + it.name + ' ' }])
      .run();
    closeMention();
  }

  function applySlash(it) {
    if (it.kind === 'cmd') {
      setPlain('/' + it.name + (it.args ? ' ' : ''));
      closeSlash();
      // /join immediately re-opens with the channel list
      if (it.name === 'join') updateSlash();
      return;
    }
    setPlain('/join ' + it.name);
    closeSlash();
  }

  // Mirrors Slack: a match on the start of the name beats a match on a later
  // word, somebody who is in this channel beats somebody who is not (they would
  // never see the message), and recency of the conversation breaks the tie.
  const matchScore = (name, typed) => {
    if (!typed) return 1;
    const low = name.toLowerCase();
    if (low.startsWith(typed)) return 2;
    return low.split(/[\s_-]+/).some((w) => w.startsWith(typed)) ? 1 : 0;
  };

  const rankMentions = (opts, typed) => {
    const scored = [];
    opts.forEach((o) => {
      const m = matchScore(o.name, typed);
      if (!m) return;
      let score = m * 1000;
      if (o.inChannel) score += 400;
      if (o.online) score += 60;
      if (o.dormant) score -= 300;   // a real handle nobody is behind any more
      scored.push({ o, score, at: o.talkedAt || '' });
    });
    scored.sort((a, b) => b.score - a.score
      || (a.at < b.at ? 1 : a.at > b.at ? -1 : 0)
      || a.o.name.localeCompare(b.o.name));
    return scored.map((s) => s.o);
  };

  const updateMention = () => {
    const { $from, empty } = editor.state.selection;
    if (!empty || !$from.parent.isTextblock) return closeMention();
    const head = $from.parent.textBetween(0, $from.parentOffset, '\0', '\0');
    const m = head.match(/(^|\s)@([A-Za-z0-9_-]*(?: [A-Za-z0-9_-]*){0,3})$/);
    if (!m) return closeMention();
    mention.from = $from.pos - m[2].length - 1;
    // broadcasts always apply to the channel you are in, so they rank with the
    // members rather than below the whole room
    const opts = getMentionOptions().concat(
      ['channel', 'everyone', 'here'].map((name) => ({ name, avatar: '📣', inChannel: true })));
    mention.items = rankMentions(opts, m[2].toLowerCase()).slice(0, 8);
    mention.sel = 0;
    renderMention();
  };

  const updateSlash = () => {
    if (!slashCommands) return;
    const { doc, selection } = editor.state;
    if (!selection.empty) return closeSlash();
    const head = doc.textBetween(0, selection.from, '\n', '\n');
    // stage 2: /join <partial> completes public channel names
    const jm = head.match(/^\/join\s+#?(\S*)$/);
    if (jm) {
      const typed = jm[1].toLowerCase();
      const fill = () => {
        slash.items = (slash.browseCache || []).filter((c) => c.name.toLowerCase().startsWith(typed))
          .map((c) => ({ kind: 'channel', name: c.name, topic: c.topic })).slice(0, 8);
        slash.sel = 0;
        renderSlash();
      };
      if (slash.browseCache) return fill();
      browseChannels().then((chs) => { slash.browseCache = chs; fill(); }).catch(() => {});
      return;
    }
    // stage 1: a lone "/word" at the very start filters command names
    const m = head.match(/^\/([a-z]*)$/i);
    const tail = doc.textBetween(selection.from, doc.content.size, '\n', '\n');
    if (!m || tail.trim() !== '') { closeSlash(); return; }
    const typed = m[1].toLowerCase();
    slash.items = slashCommands.filter((c) => c.name.startsWith(typed)).map((c) => ({ kind: 'cmd', ...c }));
    slash.sel = 0;
    renderSlash();
  };

  const popupKeydown = (box, st, pick, ev) => {
    if (box.classList.contains('hidden') || st.items.length === 0) return false;
    if (ev.key === 'ArrowDown') { st.sel = (st.sel + 1) % st.items.length; return true; }
    if (ev.key === 'ArrowUp') { st.sel = (st.sel + st.items.length - 1) % st.items.length; return true; }
    if (ev.key === 'Enter' || ev.key === 'Tab') { pick(st.items[st.sel]); return true; }
    if (ev.key === 'Escape') { st === mention ? closeMention() : closeSlash(); return true; }
    return false;
  };

  // ---------- formatting ----------

  const editLink = () => {
    const prev = editor.getAttributes('link').href || '';
    const url = window.prompt('Link URL', prev);
    if (url === null) return true;
    if (!url) { editor.chain().focus().extendMarkRange('link').unsetLink().run(); return true; }
    if (editor.state.selection.empty && !prev) {
      editor.chain().focus()
        .insertContent([{ type: 'text', marks: [{ type: 'link', attrs: { href: url } }], text: url }])
        .run();
      return true;
    }
    editor.chain().focus().extendMarkRange('link').setLink({ href: url }).run();
    return true;
  };

  const ComposerKeys = Extension.create({
    name: 'composerKeys',
    addKeyboardShortcuts() {
      return {
        'Mod-Shift-c': () => this.editor.commands.toggleCodeBlock(),
        'Mod-k': () => editLink(),
      };
    },
  });

  // StarterKit's list input rules only fire when the marker starts the whole
  // paragraph, so after Shift-Enter they never fire: the line begins after a
  // hard break. Tiptap renders that break as "\n" in the text it matches, but
  // the break must stay OUT of match[0]: Tiptap re-checks the match against the
  // document with textBetween, where a hard break is the empty string, so a
  // match that includes it never verifies. A lookbehind keeps it out. Then drop
  // the break, split the paragraph there, and wrap the new block in the list.
  const listAfterBreak = (find, toggle) => new InputRule({
    find,
    handler: ({ range, chain }) => {
      chain().deleteRange({ from: range.from - 1, to: range.to }).splitBlock()[toggle]().run();
    },
  });

  const ListAfterBreak = Extension.create({
    name: 'listAfterBreak',
    addInputRules() {
      return [
        listAfterBreak(/(?<=\n)[-+*] $/, 'toggleBulletList'),
        listAfterBreak(/(?<=\n)\d+[.)] $/, 'toggleOrderedList'),
      ];
    },
  });

  const inList = ($from) => {
    for (let d = $from.depth; d > 0; d -= 1) if ($from.node(d).type.name === 'listItem') return true;
    return false;
  };

  editor = new Editor({
    element: mount,
    contentType: 'markdown',
    content: '',
    extensions: [
      // underline has no markdown form; keep the schema serializable
      StarterKit.configure({ hardBreak: false, underline: false, link: { openOnClick: false } }),
      WireBreak,
      // breaks:true matches the feed renderer, so "\n" round-trips as a break
      Markdown.configure({ markedOptions: { breaks: true } }),
      Placeholder.configure({ placeholder }),
      ComposerKeys,
      ListAfterBreak,
    ],
    editorProps: {
      handleKeyDown: (view, ev) => {
        if (ev.isComposing) return false;
        if (popupKeydown(mentionBox, mention, applyMention, ev)) { renderMention(); return true; }
        if (popupKeydown(slashBox, slash, applySlash, ev)) { renderSlash(); return true; }
        if (ev.key !== 'Enter') return false;
        if (ev.metaKey || ev.ctrlKey) { onSubmit(); return true; }
        if (ev.shiftKey) return false; // hard break
        // Enter makes a newline inside a code block; ⌘Enter still sends
        if (view.state.selection.$from.parent.type.name === 'codeBlock') return false;
        // in a list, Enter makes the next item; an empty item lifts out of the
        // list, so a second Enter sends as usual
        if (inList(view.state.selection.$from)) return false;
        onSubmit();
        return true;
      },
      handlePaste: (view, ev) => {
        const img = [...(ev.clipboardData?.items || [])].find((i) => i.type.startsWith('image/'));
        if (img && onImageFile) {
          const file = img.getAsFile();
          if (file) { ev.preventDefault(); onImageFile(file); return true; }
        }
        const text = (ev.clipboardData?.getData('text/plain') || '').trim();
        // paste a URL over a selection -> link on the selected text
        if (URL_RE.test(text) && !view.state.selection.empty) {
          editor.chain().focus().setLink({ href: text }).run();
          return true;
        }
        return false;
      },
    },
    onUpdate: () => { updateMention(); updateSlash(); },
    onSelectionUpdate: () => { updateMention(); updateSlash(); },
    onBlur: () => setTimeout(() => { closeMention(); closeSlash(); }, 100),
  });

  // agents read the raw wire: keep typed text verbatim (the stock serializer
  // backslash-escapes `*_[]~` and HTML-encodes <>&, which would mangle plain
  // chat text like snake_case or "a > b"); marks still serialize as markdown
  editor.storage.markdown.manager.encodeTextForMarkdown = (text) => text;

  const dom = editor.view.dom;
  dom.id = id;
  // compat shim: checks and legacy callers read/write markdown via `.value`
  Object.defineProperty(dom, 'value', { get: getMarkdown, set: setMarkdown });

  const api = {
    editor, dom,
    getMarkdown, setMarkdown, getPlain,
    clear: () => editor.commands.clearContent(true),
    focus: () => editor.commands.focus('end'),
  };
  dom.__composer = api; // e2e hook
  return api;
};

/* Tiptap WYSIWYG composer. The wire format stays markdown: the editor
   serializes to markdown on send and parses markdown on restore, so agents
   and the feed renderer see exactly what the old textarea produced. */
import { Editor, Extension } from '@tiptap/core';
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

  const renderMention = () => renderList(mentionBox, mention,
    (d, it) => { d.textContent = `${it.avatar} ${it.name}`; }, applyMention);
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

  const updateMention = () => {
    const { $from, empty } = editor.state.selection;
    if (!empty || !$from.parent.isTextblock) return closeMention();
    const head = $from.parent.textBetween(0, $from.parentOffset, '\0', '\0');
    const m = head.match(/(^|\s)@([A-Za-z0-9_-]*(?: [A-Za-z0-9_-]*){0,3})$/);
    if (!m) return closeMention();
    mention.from = $from.pos - m[2].length - 1;
    const opts = getMentionOptions()
      .concat([{ name: 'channel', avatar: '📣' }, { name: 'everyone', avatar: '📣' }, { name: 'here', avatar: '📣' }]);
    const typed = m[2].toLowerCase();
    mention.items = opts.filter((o) => o.name.toLowerCase().startsWith(typed)).slice(0, 8);
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

  const format = (kind) => {
    if (kind === 'bold') return editor.chain().focus().toggleBold().run();
    if (kind === 'italic') return editor.chain().focus().toggleItalic().run();
    if (kind === 'code') return editor.chain().focus().toggleCode().run();
    if (kind === 'codeblock') return editor.chain().focus().toggleCodeBlock().run();
    if (kind === 'link') return editLink();
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
    editor, dom, format,
    getMarkdown, setMarkdown, getPlain,
    clear: () => editor.commands.clearContent(true),
    focus: () => editor.commands.focus('end'),
  };
  dom.__composer = api; // e2e hook
  return api;
};

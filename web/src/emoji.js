// Emoji dataset and helpers shared by the composer picker and the feed
// renderer. gemoji is GitHub's set, so shortcodes match what people already
// type on GitHub and Slack (:rocket:, :+1:, :tada:).
import { gemoji, nameToEmoji, emojiToName } from 'gemoji';

const RECENT_KEY = 'agentchat:emoji-recent';
const RECENT_MAX = 12;

const readRecent = () => {
  try { return JSON.parse(localStorage.getItem(RECENT_KEY) || '[]'); } catch { return []; }
};

export const rememberEmoji = (name) => {
  try {
    const next = [name].concat(readRecent().filter((n) => n !== name)).slice(0, RECENT_MAX);
    localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch { /* storage may be unavailable; recents are a nicety */ }
};

// A prefix hit on the primary name ranks first, then a prefix on an alias or
// a tag, then a substring anywhere. Recently used wins ties so the ones you
// reach for float up as you type.
export const searchEmoji = (typed, limit = 8) => {
  const q = typed.toLowerCase();
  if (!q) return [];
  const recent = readRecent();
  const scored = [];
  gemoji.forEach((e, i) => {
    let score = 0;
    if (e.names[0].startsWith(q)) score = 3;
    else if (e.names.some((n) => n.startsWith(q)) || e.tags.some((t) => t.startsWith(q))) score = 2;
    else if (e.names.some((n) => n.includes(q)) || e.description.includes(q)) score = 1;
    if (!score) return;
    const r = recent.indexOf(e.names[0]);
    scored.push({ e, i, score: score * 100 + (r >= 0 ? RECENT_MAX - r : 0) });
  });
  // dataset order breaks ties: it puts the common face before the odd one
  scored.sort((a, b) => b.score - a.score || a.i - b.i);
  return scored.slice(0, limit).map((s) => ({ emoji: s.e.emoji, name: s.e.names[0] }));
};

// :shortcode: -> emoji in plain text. Unknown codes stay as typed, and the
// colon must start a word so "12:45:00" and URLs are left alone.
const SHORTCODE_RE = /(^|[^A-Za-z0-9_:]):([a-z0-9_+-]+):/g;
export const emojify = (text) => text.replace(SHORTCODE_RE, (m, pre, name) => {
  const hit = nameToEmoji[name];
  return hit ? pre + hit : m;
});

// emoji -> :shortcode: for tooltips ("reacted with :eyes:"); a code that is
// already a shortcode, or an emoji gemoji does not know, comes back as typed
export const shortcodeOf = (emoji) => {
  const name = emojiToName[emoji] || emojiToName[emoji.replace(/\uFE0F/g, '')];
  return name ? ':' + name + ':' : emoji;
};

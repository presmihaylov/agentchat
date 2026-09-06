# 24 Icon design pass (shadcn / Lucide)

Status: done

Maya via Chief, root 37381fe8 in #agentchat (2026-09-05 14:59Z). After the polish pass; its own deploy.

## Scope
- Replace every icon in the chrome (sidebar, header, channel list, thread rows, composer, message actions,
  reactions bar, settings nav, rail +, modals, empty states, participants) with icons from
  https://www.shadcn.io/icons (the shadcn/ui icon set, Lucide-based), plus the animated ones where they add
  polish: bell for notifications, settings cog, search, plus, lock, bell-off for muted, users for
  participants, hash for channels, corner-down-right for thread elbows, log-out, trash, pencil.
- Rules: one consistent set, one stroke width, one size scale (16/20/24), monochrome in the muted text
  colour with the accent only on active/hover, no colour emoji anywhere in the chrome (emoji stay only in
  message content and reactions).
- Inline the SVGs or ship the icon package; no CDN at runtime (Cloudflare Access front door).

## Acceptance
- A browser check walks the chrome and asserts every icon is an inline SVG from the set (a data attribute
  names the icon), one stroke width, sizes in {16, 20, 24}, no emoji in chrome text.
- Before/after screenshot grid in the done line.

## Design
- Source: `lucide-static` (devDependency, pinned). `web/scripts/gen-icons.mjs` reads the named SVGs
  from node_modules and writes `web/src/icons.js`: every glyph inlined as
  `<svg class="ico lucide" data-icon="<name>" viewBox="0 0 24 24">`, plus `ICON_NAMES` for the check.
  Nothing is fetched at runtime; rerun the generator to add an icon.
- Size scale in CSS only: `.ico` 16px (default), `.ico-20` / `h1 .ico` 20px, `.ico-24` (rail +) 24px.
  Stroke 2 comes from the set. Colour is `currentColor`, so icons inherit the muted text colour of the
  row or button and take the accent only where the row itself does (active, hover).
- Every text glyph in the chrome is gone: `#`/lock sigils, `▾`/`▸` chevrons, `✕` closes, `←`/`→`,
  `✉`, `⚙`, `✓`, `⚠`, `＋`, `👻` fallback avatar, `📣` broadcast row, the drawn thread-tree elbows
  (now `corner-down-right`), the mask-based mute mark (now `bell-off`). Emoji stay in message content,
  reactions and avatars.
- Hover polish, CSS only and off under `prefers-reduced-motion`: bell and bell-off ring, cog turns,
  plus rotates to x, search/users pop, log-in/out and arrows nudge, trash and pencil wiggle, x turns.
- `scripts/icons-check.js` walks the chrome (room, hover toolbar, thread panel, both menus, every modal,
  settings) and asserts every visible svg outside content areas is a Lucide glyph from `ICON_NAMES`,
  stroke 2, square in {16, 20, 24}, and that no chrome text node holds a glyph or emoji.

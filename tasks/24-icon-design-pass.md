# 24 Icon design pass (shadcn / Lucide)

Status: todo

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

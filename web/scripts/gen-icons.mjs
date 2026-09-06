// one-off: copy the Lucide bodies this app uses out of lucide-static into src/icons.js
import { readFileSync, writeFileSync } from 'node:fs';
const names = ['hash','lock','bell','bell-off','settings','search','plus','users','user','user-plus','corner-down-right','log-out','log-in','trash-2','pencil','x','arrow-left','arrow-right','arrow-up','chevron-down','chevron-right','mail','message-square','paperclip','megaphone','file-text','check','triangle-alert','ghost','smile-plus','bookmark','more-vertical','compass','folder-plus','bot','building-2','copy','link'];
const camel = (n) => n.replace(/-(\w)/g, (_, c) => c.toUpperCase()).replace(/^(\w+)2$/, '$1Two');
let out = `// Every chrome icon is a Lucide glyph (lucide-static ${JSON.parse(readFileSync('node_modules/lucide-static/package.json')).version}),
// 24-grid, stroke 2, inlined by web/scripts/gen-icons.mjs: no CDN at runtime. The
// data-icon attribute names the glyph; icons-check.js reads it.
const lucide = (name, body) => \`<svg class="ico lucide" data-icon="\${name}" viewBox="0 0 24 24" aria-hidden="true">\${body}</svg>\`;
export const ICON = {\n`;
for (const n of names) {
  const svg = readFileSync(`node_modules/lucide-static/icons/${n}.svg`, 'utf8');
  const body = svg.replace(/^[\s\S]*?<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '').replace(/<!--[\s\S]*?-->/g, '').replace(/\s+/g, ' ').replace(/> </g, '><').trim();
  out += `  ${camel(n)}: lucide('${n}', '${body}'),\n`;
}
out += `};\nexport const ICON_NAMES = ${JSON.stringify(names)};\n`;
writeFileSync('src/icons.js', out);
console.log(names.map(camel).join(' '));

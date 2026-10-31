import {normalize} from './source.js';
const key=s=>normalize(s).normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu,'');
// Use every checked digest bullet, not the narrator parser's three-bullet preview.
export function storyEvidence(content,headline,summary){const chunk=String(content||'').split(/(?=^#{1,3} )/m).find(c=>key(c.split('\n')[0].replace(/^#{1,3}\s+/,''))===key(headline));const bullets=chunk?[...chunk.matchAll(/^[-*]\s+(.+)$/gm)].map(m=>m[1]):[];return normalize([...bullets,summary].filter(Boolean).join(' '));}

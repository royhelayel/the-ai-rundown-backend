import fs from 'node:fs';
import { animationKey, cleanAnimationText, validateAnimation } from '../story-animation-schema.js';

// A reviewed, content-addressed edition. Serving these records has no model or
// storage write side effects; future publications never silently incur AI charges.
const edition=JSON.parse(fs.readFileSync(new URL('./2026-10-27.en.json',import.meta.url),'utf8'));
const records=new Map();
for(const entry of edition.entries) {
 const text=cleanAnimationText(entry.text), key=animationKey(text);
 if(entry.key!==key) throw new Error('Editorial animation text/key mismatch');
 records.set(key,{version:1,text,status:'ready',plan:validateAnimation(entry.plan,text),origin:'editorial'});
}
export function editorialAnimation(text) { return records.get(animationKey(text)) || null; }
export const editorialAnimationStatus={day:edition.day,language:edition.language,quick:edition.entries.filter(e=>e.kind==='quick').length,
 full:edition.entries.filter(e=>e.kind==='full').length,records:records.size,topics:new Set(edition.entries.map(e=>e.category)).size};

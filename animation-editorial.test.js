import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { editorialAnimation, editorialAnimationStatus } from './animation-editorial/index.js';
import { animationKey, validateAnimation } from './story-animation-schema.js';
import { createStoryAnimations } from './story-animations.js';
const edition=JSON.parse(fs.readFileSync(new URL('./animation-editorial/2026-10-27.en.json',import.meta.url)));
test('the entire editorial edition is grounded and covers all quick/full published updates',()=>{
 assert.equal(editorialAnimationStatus.quick,162);assert.equal(editorialAnimationStatus.full,183);assert.equal(editorialAnimationStatus.topics,16);
 for(const entry of edition.entries) {
  assert.equal(entry.key,animationKey(entry.text));
  assert.deepEqual(validateAnimation(entry.plan,entry.text),entry.plan);
  for(const el of entry.plan.elements.filter(e=>e.type==='label')) assert.match(el.text,/[\p{L}]/u);
 }
});
test('changed source copy never inherits a cached illustration',()=>{
 const text=edition.entries[0].text;
 assert.ok(editorialAnimation(text)?.plan);
 assert.equal(editorialAnimation(text+' This is a changed report.'),null);
});
test('editorial lookup with paid generation disabled never touches a provider or storage',async()=>{
 const service=createStoryAnimations({supabase:new Proxy({},{get(){throw new Error('Unexpected database access');}}),
  callModel(){throw new Error('Unexpected paid generation');},parseStories:()=>[],sentences:()=>[]});
 for(const entry of edition.entries) assert.ok((await service.read(entry.text)).plan);
 assert.equal(service.stats.enabled,false);assert.equal(service.stats.generated,0);
});

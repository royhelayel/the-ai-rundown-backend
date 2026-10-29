import fs from 'node:fs';
import { makeDrawing } from './drawings.mjs';
import { designs, extraDesigns } from './edition-designs.mjs';
import { cleanAnimationText, validateAnimation, animationKey } from '../story-animation-schema.js';
const {updates,full}=JSON.parse(fs.readFileSync(new URL('./source.json',import.meta.url)));
if(designs.length!==updates.length) throw new Error('Every published update needs an explicit scene design');
const entries=[];
const add=(row,spec,kind,id)=>{
 const text=cleanAnimationText(row.text);
 const plan=validateAnimation(makeDrawing(spec,text,id),text);
 entries.push({text,plan,key:animationKey(text),category:row.category,kind,design:id});
};
updates.forEach((row,i)=>add(row,designs[i],'quick',i));
full.forEach((row,i)=>add(row,extraDesigns[i] || designs[row.recapId],'full',i));
const edition={version:1,day:'2026-10-27',language:'en',provenance:'Editorially authored vector geometry; no generation API calls',entries};
fs.writeFileSync(new URL('./2026-10-27.en.json',import.meta.url),JSON.stringify(edition));
console.log(`Built ${updates.length} quick updates and ${full.length} full summaries without provider calls.`);

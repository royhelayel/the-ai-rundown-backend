import {normalize} from './source.js';
// IDs bind model evidence to immutable input; models never have to retype source prose.
export function sourceSentences(job) {
  const rows=[];
  for(const [prefix,text] of [['F',job.fullText],['Q',job.shortText]]) {
    const sentences=normalize(text||'').split(/(?<=[.!?])\s+(?=[\p{Lu}\p{N}])/u).filter(Boolean);
    sentences.forEach((text,i)=>rows.push({id:prefix+(i+1),text}));
  }
  return rows;
}
const refsValid=(ids,sources)=>Array.isArray(ids)&&ids.length>0&&ids.every(id=>typeof id==='string'&&sources.has(id));
export function validatePlan(raw,job) {
  const plan=structuredClone(raw),sources=new Set(sourceSentences(job).map(s=>s.id));
  plan.script=normalize(job.shortText||plan.script||'');
  if(!plan.script||plan.script.length>600||plan.script.split(/\s+/).length>75)throw Error('Invalid short script');
  if(!Array.isArray(plan.beats)||!plan.beats.length||plan.beats.length>2||!refsValid(plan.evidenceIds,sources)||plan.beats.some(b=>!refsValid(b.sourceIds,sources)))throw Error('Animation plan lacks exact source support');
  if(plan.beats.some(b=>!Number.isFinite(b.start)||!Number.isFinite(b.end)||b.start<0||b.end>1||b.end<=b.start))throw Error('Invalid beat timing');
  return plan;
}
export function reviewAudit(audit,job,plan,code) {
  const sources=new Set(sourceSentences(job).map(s=>s.id));
  if(!audit||!Array.isArray(audit.issues)||typeof audit.pass!=='boolean')return {invalid:true,reason:'Invalid grounding audit'};
  if(audit.pass===true&&!audit.issues.length)return {pass:true};
  if(!audit.issues.length||audit.issues.some(i=>!['script','code'].includes(i.scope)||!refsValid(i.sourceIds,sources)||typeof i.issue!=='string'||!i.issue.trim()||typeof i.sceneQuote!=='string'||normalize(i.sceneQuote).length<3||!normalize(plan.script+' '+code).includes(normalize(i.sceneQuote))))return {invalid:true,reason:'Grounding review could not substantiate approval'};
  if(audit.issues.some(i=>i.scope==='script'))return {scriptRejected:true,reason:'Short script failed source grounding'};
  return {reason:audit.issues.map(i=>i.issue).join('; ').slice(0,2000)};
}

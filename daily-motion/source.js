import crypto from'node:crypto';
import{cleanAnimationText}from'../story-animation-schema.js';
export const VERSION='remotion-haiku-v1';
// Source-focus review + normalized timing/readability policy; old artifacts remain readable.
export const GENERATION_POLICY='focus-normalized-v2';
export const normalize=cleanAnimationText;
export const hash=s=>crypto.createHash('sha256').update(s).digest('hex');
export const DEFAULT_CATEGORIES=['World News','Business'];
export const model=process.env.DAILY_MOTION_MODEL||'claude-haiku-4-5-20251001';
export const budget={perJobUSD:0.125,maxDailyUSD:Math.max(0,Number(process.env.DAILY_MOTION_DAILY_USD??3)),maxDailyJobs:Math.max(0,Number(process.env.DAILY_MOTION_MAX_DAILY_JOBS??24))};
export const enabled=process.env.DAILY_MOTION_ENABLED!=='false';
export const categories=(process.env.DAILY_MOTION_CATEGORIES||DEFAULT_CATEGORIES.join(',')).split(',').map(s=>s.trim()).filter(Boolean);
export const spendDay=now=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Dubai',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(now));
const headline=s=>String(s||'').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu,'');
export const aliasPath=(meta,text)=>`aliases/${hash(JSON.stringify([meta.category,meta.day,meta.language||'en',normalize(text)]))}.json`;
export function verified(row){const a=row.audit_result;return !!(a?.checked&&!a.error&&!a.recheckError&&(!a.reserveCheck||a.reserveCheck.checked&&!a.reserveCheck.error&&!a.reserveCheck.recheckError));}
export function prepareJobs(row,parseStories,{allowed=categories,requireVerified=true}={}){
 if(!allowed.includes(row.category)||!['Morning','Evening','Daily'].includes(row.time_slot)||row.user_id||row.shared_key||requireVerified&&!verified(row))return[];
 const stories=parseStories(row).filter(s=>s.headline&&normalize(s.summary));let parts=row.briefing_sources;if(typeof parts==='string'){try{parts=JSON.parse(parts);}catch{parts=null;}}
 const mapped=Array.isArray(parts)&&parts.length&&parts.every(p=>typeof p?.text==='string')&&normalize(parts.map(p=>p.text).join(' '))===normalize(row.briefing);
 return stories.map(st=>{const fullText=normalize(st.summary);if(fullText.length>2400)return null;const matches=mapped?parts.filter(p=>p.stories?.length===1&&headline(p.stories[0].headline)===headline(st.headline)).map(p=>normalize(p.text)).filter(Boolean):[];const shortText=normalize(matches.join(' '));const firstSentence=fullText.split(/(?<=[.!?])\s+(?=[\p{Lu}\p{N}])/u)[0];const focus=shortText&&shortText.split(/\s+/).length<=65?shortText:firstSentence.split(/\s+/).length<=65?firstSentence:'';if(!focus)return null;const key=hash(JSON.stringify([VERSION,GENERATION_POLICY,model,row.language||'en',fullText,focus]));const meta={category:row.category,day:row.day,timeSlot:row.time_slot,language:row.language||'en'};return{key,meta,headline:st.headline,fullText,shortText:focus,aliases:[{text:fullText,from:0,to:1},...matches.map(text=>{const at=focus.indexOf(text);return{text,from:at>=0?at/focus.length:0,to:at>=0?(at+text.length)/focus.length:1};})]};}).filter(Boolean);
}

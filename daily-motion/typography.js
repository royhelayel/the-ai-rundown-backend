import {parse} from '@babel/parser';
// Shared presentation policy only: never changes text, facts, objects or motion geometry.
export function normalizeTypography(code){const ast=parse(code,{sourceType:'module',plugins:['jsx']}),edits=[];
 const visit=n=>{if(!n||typeof n!=='object')return;if(Array.isArray(n)){n.forEach(visit);return;}
 if(n.type==='JSXAttribute'&&n.name?.name==='fontSize'||n.type==='ObjectProperty'&&n.key?.name==='fontSize'){
 const v=n.type==='JSXAttribute'?(n.value?.expression||n.value):n.value;
 if(v&&['NumericLiteral','StringLiteral'].includes(v.type)&&/^\d+(?:\.\d+)?(?:px)?$/.test(String(v.value))&&parseFloat(v.value)<30)edits.push({start:v.start,end:v.end,from:v.value,to:30,value:v.type==='StringLiteral'?JSON.stringify('30'):'30'});}
 for(const[k,v]of Object.entries(n))if(!['loc','start','end','extra','comments','tokens'].includes(k)&&v&&typeof v==='object')visit(v);};visit(ast);
 let result=code;for(const e of edits.sort((a,b)=>b.start-a.start))result=result.slice(0,e.start)+e.value+result.slice(e.end);return{code:result,adjustments:edits.map(({start,from,to})=>({offset:start,from,to}))};
}

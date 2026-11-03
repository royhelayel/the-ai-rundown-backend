// Speech-only normalization. Source text, attribution keys and visual scripts stay unchanged.
const number='\\d[\\d,]*(?:\\.\\d+)?';
const currency='(?:US\\$|USD\\s*\\$?|AU?\\$|CA?\\$|HK\\$|S\\$|\\$|£|€)';
const magnitude='(?:trillion|billion|million|thousand|tn|bn|mn|[tbmk])s?\\b';
const digits=['zero','one','two','three','four','five','six','seven','eight','nine'];
const decimal=n=>n.includes('.')?n.split('.')[0]+' point '+n.split('.')[1].split('').map(d=>digits[Number(d)]).join(' '):n;
const unit=token=>({US:'US dollars',USD:'US dollars',A:'Australian dollars',AU:'Australian dollars',C:'Canadian dollars',CA:'Canadian dollars',HK:'Hong Kong dollars',S:'Singapore dollars','£':'pounds','€':'euros'}[token.replace(/[\s$]/g,'').toUpperCase()]||'dollars');
const scale=token=>({t:'trillion',tn:'trillion',b:'billion',bn:'billion',m:'million',mn:'million',k:'thousand'}[token.toLowerCase().replace(/s$/,'')]||token.toLowerCase().replace(/s$/,''));
export function currencySpeech(input){
 const source=String(input||''),pattern=new RegExp(`(${currency})\\s*(${number})(?:\\s*[-–—]\\s*(?:${currency}\\s*)?(${number}))?\\s*(?:in\\s+)?(${magnitude})`,'g');
 let text='',cursor=0;const replacements=[];
 for(const match of source.matchAll(pattern)){
  const start=match.index,end=start+match[0].length;
  const modifier=/^\s+(?:hack|theft|deal|sale|loss|fund|investment|package|contract|bid|offer|fine|loan|budget|settlement|payment|project|transaction)\b/i.test(source.slice(end));
  const currencyUnit=modifier?unit(match[1]).replace(/s$/,''):unit(match[1]);
  const spoken=decimal(match[2])+(match[3]?' to '+decimal(match[3]):'')+' '+scale(match[4])+' '+currencyUnit;
  text+=source.slice(cursor,start);const outStart=text.length;text+=spoken;replacements.push({start,end,outStart,outEnd:text.length});cursor=end;
 }
 text+=source.slice(cursor);
 const toSource=position=>{
  const index=Math.max(0,Math.min(text.length,Number(position)||0));let shift=0;
  for(const r of replacements){if(index<r.outStart)return index-shift;if(index<r.outEnd)return r.start+Math.floor((index-r.outStart)*(r.end-r.start)/(r.outEnd-r.outStart));shift+=(r.outEnd-r.outStart)-(r.end-r.start);}
  return Math.min(source.length,index-shift);
 };
 return{text,toSource};
}
export const normalizeCurrencyText=text=>currencySpeech(text).text;

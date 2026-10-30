// Trusted visual operators, not story/topic templates. The model draws objects and
// chooses a story-specific composition; code makes their state changes coherent.
const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
function bounds(o){const rects=o.shapes.filter(s=>s.type==='rect');if(rects.length){const x=Math.min(...rects.map(s=>s.x)),y=Math.min(...rects.map(s=>s.y)),right=Math.max(...rects.map(s=>s.x+s.width)),bottom=Math.max(...rects.map(s=>s.y+s.height));return{x,y,width:right-x,height:bottom-y};}return{x:-70,y:-70,width:140,height:140};}
const frame=(t,p)=>({t,...p});
export function compileMechanics(input,text){const p=structuredClone(input),source=[...new Intl.Segmenter('en',{granularity:'sentence'}).segment(text)].map(s=>s.segment);const notes=[];
 for(const shot of p.shots){
  // Reserve a consistent caption zone; model coordinates cannot clip labels.
  shot.labels=shot.labels.map((l,i,all)=>({...l,x:all.length===1?300:all.length===2?160+i*280:110+i*190,y:334,width:all.length===1?500:all.length===2?250:180}));
  const ratio=shot.sourceIds.map(id=>source[id]).filter(Boolean).join(' ').match(/(\d[\d,]*)\s+of\s+(?:(?:its|the)\s+)?(\d[\d,]*)/i);
  if(ratio&&/bar|proportion|attendance|share|attend|absen/i.test(shot.action)){
   const numerator=Number(ratio[1].replace(/,/g,'')),denominator=Number(ratio[2].replace(/,/g,''));if(numerator>=0&&denominator>0&&numerator<=denominator){
    const primary=shot.labels.map(l=>p.labels[l.label].text).find(s=>s.includes(ratio[1])&&s.includes(ratio[2]))||ratio[0];const secondary=shot.labels.map(l=>p.labels[l.label].text).find(s=>s!==primary&&!s.includes(ratio[1]));
    shot.chart={numerator,denominator,sourceQuote:ratio[0],primary,secondary:secondary||''};shot.action='Reveal the reported proportion, using the exact source counts.';notes.push('source-derived ratio');continue;
   }
  }
  const objects=Object.fromEntries(p.objects.map(o=>[o.id,o]));
  const doorFrame=shot.actors.find(a=>/door.?frame|doorway.*frame|static surround/i.test(a.object+' '+objects[a.object]?.description));
  const leaf=shot.actors.find(a=>/door.?leaf|door panel/i.test(a.object+' '+objects[a.object]?.description));
  if(doorFrame&&leaf&&/shut|clos|open/i.test(shot.action)){
   const outer=bounds(objects[doorFrame.object]),panel=bounds(objects[leaf.object]),base=doorFrame.frames[0];const innerW=Math.max(30,outer.width-14),innerH=Math.max(40,outer.height-14),closing=/shut|clos/i.test(shot.action);
   leaf.contentTransform={sx:innerW/Math.max(1,panel.width),sy:innerH/Math.max(1,panel.height),tx:-panel.x,ty:-(panel.y+panel.height/2)};
   const pose={x:base.x+(outer.x+7)*base.sx,y:base.y+(outer.y+outer.height/2)*base.sy,sx:closing?.08:1,sy:1,r:0,o:1};
   leaf.frames=[frame(0,pose),frame(.12,pose),frame(.75,{...pose,sx:closing?1:.08}),frame(1,{...pose,sx:closing?1:.08})];notes.push(closing?'hinged door closes':'hinged door opens');
  }
  for(const actor of shot.actors){const o=objects[actor.object],name=actor.object+' '+o.description,first=actor.frames[0];
   if(/(?:clock|minute|hour).?hand/i.test(name)){
    const span=Math.max(...actor.frames.map(f=>Math.abs(f.r-first.r)));if(span>540){actor.frames=actor.frames.map(f=>({...f,r:first.r+(f.r-first.r)*540/span}));notes.push('readable clock-hand speed');}
   }
   if(/coin|packet|money.?bag|stolen.?funds|asset.*token|funds.*token/i.test(name)&&/stolen|steal|theft|transfer|travel|launch/i.test(shot.action)&&!/lock|freez/i.test(shot.action)){
    const last=actor.frames.at(-1),b=bounds(o);const from={...first,o:1,sx:Math.max(.8,first.sx),sy:Math.max(.8,first.sy)};
    const end={...last,x:clamp(last.x,80,Math.min(520,575-(b.x+b.width))),y:clamp(last.y,90,240),sx:1,sy:1,o:1};if(Math.hypot(end.x-from.x,end.y-from.y)>55){actor.frames=[frame(0,from),frame(.08,from),frame(.76,end),frame(1,end)];notes.push('visible transfer with held result');}
   }
  }
 }
 p.mechanics=[...new Set(notes)];return p;
}

// Editorial vector building blocks. Scenes are explicitly composed per published
// development in edition-designs.mjs; no topic/keyword classifier selects a scene.
const shapes = {
 ball: [['circle',40,40,32],['path','M 8 40 L 72 40 M 40 8 C 18 22 18 58 40 72 M 40 8 C 62 22 62 58 40 72']],
 jersey: [['path','M 24 10 L 8 22 L 17 40 L 25 35 L 25 72 L 62 72 L 62 35 L 70 40 L 79 22 L 63 10 Q 43 30 24 10 Z']],
 medical: [['rect',8,20,68,48,9],['path','M 31 20 L 31 10 L 53 10 L 53 20 M 42 33 L 42 55 M 31 44 L 53 44']],
 calendar: [['rect',8,16,68,59,8],['path','M 8 33 L 76 33 M 25 8 L 25 24 M 59 8 L 59 24 M 26 48 L 35 48 M 49 48 L 58 48 M 26 60 L 35 60']],
 scan: [['rect',7,9,70,68,9],['path','M 19 20 L 29 20 M 19 20 L 19 30 M 65 20 L 55 20 M 65 20 L 65 30 M 19 65 L 29 65 M 65 65 L 55 65 M 19 43 L 65 43']],
 agreement: [['path','M 5 35 L 19 24 L 35 28 L 45 21 L 78 38 L 66 61 L 54 58 L 46 65 L 38 58 L 30 60 L 8 43 M 35 28 L 27 38 Q 26 48 35 45 L 45 38 L 63 52']],
 trophy: [['path','M 24 10 L 61 10 L 58 35 Q 43 60 27 35 Z M 24 17 L 8 17 Q 6 39 29 39 M 61 17 L 77 17 Q 80 39 57 39 M 43 49 L 43 66 M 28 71 L 59 71']],
 football: [['circle',42,40,33],['polygon',[42,22,58,34,52,52,32,52,26,34]],['path','M 42 7 L 42 22 M 75 30 L 58 34 M 62 67 L 52 52 M 22 67 L 32 52 M 10 29 L 26 34']],
 pause: [['rect',19,13,16,58,5],['rect',49,13,16,58,5]],
 people: [['circle',27,23,12],['circle',61,23,12],['path','M 8 70 L 8 57 Q 8 39 27 39 Q 46 39 46 57 L 46 70 M 46 43 Q 78 34 79 57 L 79 70']],
 stadium: [['ellipse',42,40,36,22],['path','M 6 40 L 6 58 Q 42 85 78 58 L 78 40 M 21 46 L 21 64 M 42 52 L 42 72 M 63 46 L 63 64']],
 speech: [['path','M 8 14 L 74 14 L 74 56 L 43 56 L 26 72 L 26 56 L 8 56 Z'],['path','M 23 29 L 59 29 M 23 41 L 48 41']],
 microphone: [['rect',28,6,28,43,14],['path','M 17 32 L 17 43 Q 42 78 67 43 L 67 32 M 42 61 L 42 75 M 28 77 L 56 77']],
 bank: [['polygon',[8,28,42,7,77,28]],['path','M 8 72 L 77 72 M 13 64 L 72 64 M 20 35 L 20 62 M 42 35 L 42 62 M 64 35 L 64 62']],
 coin: [['circle',42,40,32],['circle',42,40,24],['path','M 42 22 L 42 58 M 54 26 L 35 26 Q 25 40 42 40 Q 60 41 49 54 L 29 54']],
 document: [['path','M 16 6 L 53 6 L 71 24 L 71 77 L 16 77 Z M 53 6 L 53 24 L 71 24 M 28 38 L 58 38 M 28 49 L 58 49 M 28 61 L 49 61']],
 shield: [['path','M 42 6 L 74 18 L 69 49 Q 58 70 42 78 Q 24 70 14 49 L 9 18 Z'],['path','M 27 41 L 38 53 L 59 29']],
 clock: [['circle',42,41,33],['path','M 42 18 L 42 41 L 58 50']],
 wallet: [['rect',7,20,69,49,8],['rect',47,35,30,22,5],['circle',59,46,3]],
 key: [['circle',24,29,15],['path','M 35 40 L 68 73 M 54 58 L 64 48 M 62 66 L 72 56']],
 chip: [['rect',20,18,44,45,7],['path','M 7 28 L 20 28 M 7 51 L 20 51 M 64 28 L 77 28 M 64 51 L 77 51 M 30 5 L 30 18 M 53 5 L 53 18 M 30 63 L 30 77 M 53 63 L 53 77'],['rect',31,30,22,21,3]],
 server: [['rect',8,12,68,26,5],['rect',8,46,68,26,5],['path','M 21 25 L 30 25 M 21 59 L 30 59 M 49 25 L 65 25 M 49 59 L 65 59']],
 warning: [['polygon',[42,8,79,72,5,72]],['path','M 42 30 L 42 49'],['circle',42,60,2]],
 cloud: [['path','M 18 61 C -3 61 0 30 23 30 C 24 0 61 0 64 28 C 89 24 91 61 68 61 Z']],
 factory: [['path','M 6 74 L 6 37 L 30 22 L 30 37 L 53 22 L 53 50 L 62 50 L 62 14 L 74 14 L 78 74 Z'],['path','M 16 53 L 23 53 M 37 53 L 44 53 M 16 65 L 23 65 M 37 65 L 44 65']],
 phone: [['rect',21,4,43,75,9],['path','M 35 13 L 50 13 M 37 68 L 48 68']],
 inbox: [['rect',7,18,70,50,7],['path','M 8 22 L 42 47 L 76 22']],
 robot: [['rect',10,22,64,47,10],['circle',29,42,5],['circle',55,42,5],['path','M 42 22 L 42 9 M 30 57 L 54 57']],
 gavel: [['path','M 30 12 L 58 34 L 47 49 L 19 27 Z M 37 40 L 65 71 M 12 72 L 39 72']],
 home: [['path','M 6 37 L 42 7 L 78 37 M 17 29 L 17 75 L 67 75 L 67 29 M 34 75 L 34 51 L 51 51 L 51 75']],
 network: [['path','M 16 20 L 68 20 L 42 68 Z'],['circle',16,20,10],['circle',68,20,10],['circle',42,68,10]],
 globe: [['circle',42,40,33],['ellipse',42,40,15,33],['path','M 9 40 L 75 40 M 16 21 Q 42 36 68 21 M 16 59 Q 42 45 68 59']],
 plane: [['path','M 36 8 Q 42 1 48 8 L 48 31 L 77 51 L 77 59 L 48 49 L 48 65 L 59 73 L 59 78 L 42 73 L 25 78 L 25 73 L 36 65 L 36 49 L 7 59 L 7 51 L 36 31 Z']],
 baby: [['circle',42,31,20],['path','M 24 48 Q 1 54 18 76 L 65 76 Q 82 54 60 48 M 36 12 Q 42 2 48 13 M 35 37 Q 42 42 49 37']],
 dress: [['path','M 26 8 L 35 8 Q 42 19 49 8 L 58 8 L 52 33 L 76 74 L 8 74 L 32 33 Z']],
 pottery: [['path','M 27 8 L 57 8 L 57 20 Q 76 35 73 55 Q 73 77 42 77 Q 11 77 11 55 Q 8 35 27 20 Z M 17 48 L 68 48']],
 tree: [['path','M 42 77 L 42 44 M 42 59 L 23 42 M 42 49 L 61 30'],['path','M 42 7 Q 59 4 61 22 Q 83 26 72 47 Q 57 61 42 51 Q 24 63 10 48 Q -1 30 20 21 Q 24 3 42 7 Z']],
 train: [['rect',15,8,54,60,10],['rect',24,20,36,22,4],['path','M 25 55 L 30 55 M 54 55 L 59 55 M 25 68 L 16 79 M 59 68 L 68 79']],
 car: [['path','M 9 39 L 19 17 L 61 17 L 73 39 L 77 39 L 77 65 L 7 65 L 7 39 Z M 15 39 L 66 39'],['circle',22,65,9],['circle',63,65,9]],
 tent: [['path','M 42 9 L 78 72 L 6 72 Z M 42 28 L 63 72 L 21 72 Z']],
 art: [['rect',8,8,68,67,4],['path','M 19 63 L 34 39 L 48 55 L 58 45 L 67 63 Z'],['circle',57,27,8]],
 heart: [['path','M 42 74 C -15 38 10 -5 42 20 C 74 -5 99 38 42 74 Z']],
 eye: [['path','M 5 40 Q 42 -1 79 40 Q 42 81 5 40 Z'],['circle',42,40,15],['circle',42,40,5]],
 pan: [['ellipse',34,38,28,15],['path','M 6 38 L 6 51 Q 34 77 62 51 L 62 38 M 62 44 L 80 31']],
 pharmacy: [['rect',12,17,60,59,5],['path','M 42 30 L 42 62 M 27 46 L 57 46 M 23 17 L 23 8 L 61 8 L 61 17']],
 pill: [['path','M 20 62 Q 3 48 20 31 L 44 7 Q 61 -10 77 7 Q 92 24 75 41 L 51 65 Q 35 82 20 62 Z M 34 18 L 64 48']],
 syringe: [['path','M 18 63 L 58 23 L 70 35 L 30 75 Z M 56 10 L 81 35 M 68 22 L 77 13 M 18 75 L 8 85 M 29 52 L 37 60 M 40 41 L 48 49']],
 mushroom: [['path','M 8 44 Q 12 3 42 5 Q 72 3 78 44 Z'],['path','M 32 44 L 30 76 Q 42 84 54 76 L 52 44 Z'],['path','M 42 16 L 42 35 M 24 27 L 21 37 M 60 27 L 64 37']],
 dna: [['path','M 23 7 C 75 25 6 57 60 77 M 60 7 C 8 25 77 57 23 77'],['path','M 27 11 L 57 11 M 31 29 L 53 29 M 28 55 L 56 55 M 25 73 L 58 73']],
 leaf: [['path','M 13 70 Q -4 7 75 9 Q 77 79 13 70 Z M 13 70 L 59 24 M 27 55 L 25 33 M 40 43 L 60 44']],
 atom: [['ellipse',42,40,36,14],['path','M 21 7 C 59 7 86 73 62 73 C 24 73 -3 7 21 7 M 62 7 C 24 7 -3 73 21 73 C 59 73 86 7 62 7'],['circle',42,40,6]],
 volcano: [['path','M 6 75 L 32 32 L 52 32 L 78 75 Z M 32 32 L 42 42 L 52 32 M 27 9 L 36 22 M 58 7 L 49 22 M 42 3 L 42 17']],
 bird: [['path','M 9 50 Q 20 32 36 40 Q 29 11 53 9 Q 73 7 70 27 L 80 32 L 69 36 Q 67 63 45 66 Q 19 79 9 50 Z'],['circle',59,22,3]],
 satellite: [['rect',29,28,28,29,5],['path','M 29 28 L 13 12 L 1 25 L 29 54 M 57 32 L 75 48 L 84 34 L 57 8 M 43 57 L 43 74 M 28 74 Q 43 61 58 74']],
 monkey: [['circle',14,40,12],['circle',70,40,12],['circle',42,38,30],['ellipse',42,48,20,19],['path','M 31 34 L 32 34 M 52 34 L 53 34 M 32 54 Q 42 60 52 54']],
 moon: [['circle',44,41,32],['circle',32,25,7],['circle',57,47,9],['circle',30,56,4]],
 stage: [['path','M 7 72 L 77 72 M 7 9 L 77 9 M 12 10 L 12 62 Q 26 54 27 10 M 72 10 L 72 62 Q 58 54 57 10'],['rect',28,67,29,8,2]],
 headphones: [['path','M 11 46 L 11 35 Q 11 4 42 4 Q 73 4 73 35 L 73 46'],['rect',7,38,18,34,8],['rect',59,38,18,34,8]],
 video: [['rect',6,15,72,54,7],['polygon',[33,28,33,56,56,42]]],
 film: [['rect',7,8,70,68,5],['path','M 21 8 L 21 76 M 63 8 L 63 76 M 7 24 L 21 24 M 7 44 L 21 44 M 7 64 L 21 64 M 63 24 L 77 24 M 63 44 L 77 44 M 63 64 L 77 64']],
 book: [['path','M 42 16 Q 23 2 5 10 L 5 68 Q 24 60 42 75 Q 60 60 79 68 L 79 10 Q 61 2 42 16 Z M 42 16 L 42 75']],
 music: [['path','M 33 59 L 33 15 L 69 7 L 69 51 M 33 28 L 69 20'],['ellipse',21,62,12,9],['ellipse',57,54,12,9]],
 ballot: [['rect',12,38,60,38,5],['path','M 27 45 L 58 45 M 25 10 L 53 4 L 63 33 L 35 40 Z M 35 20 L 42 26 L 51 14']],
 passport: [['rect',14,8,56,69,5],['circle',42,39,16],['path','M 26 39 L 58 39 M 42 23 Q 58 39 42 55 Q 26 39 42 23 M 29 67 L 55 67']],
 border: [['path','M 10 75 L 10 31 L 76 31 M 73 75 L 73 52 M 23 31 L 37 17 M 42 31 L 56 17 M 61 31 L 75 17'],['circle',10,21,8]],
 suitcase: [['rect',9,23,66,52,8],['path','M 28 23 L 28 11 L 56 11 L 56 23 M 25 23 L 25 75 M 59 23 L 59 75']],
 podium: [['path','M 18 41 L 66 41 L 61 76 L 23 76 Z M 37 41 L 37 23 Q 37 15 47 15 L 56 15'],['circle',59,15,4]],
 receipt: [['path','M 18 5 L 65 5 L 65 76 L 57 69 L 49 76 L 41 69 L 33 76 L 25 69 L 18 76 Z M 28 21 L 56 21 M 28 35 L 56 35 M 28 49 L 45 49']],
 tag: [['path','M 5 16 L 44 7 L 78 42 L 43 77 L 8 43 Z'],['circle',26,27,5]],
 chart: [['path','M 9 8 L 9 73 L 79 73 M 20 20 L 38 38 L 51 30 L 72 60']],
 desk: [['path','M 5 47 L 79 47 M 15 47 L 15 77 M 69 47 L 69 77'],['rect',18,7,48,29,4],['path','M 42 36 L 42 47']],
 foldphone: [['path','M 8 15 L 40 7 L 77 15 L 77 72 L 42 77 L 8 70 Z M 42 8 L 42 77 M 48 28 L 38 39 L 47 49 L 39 61']],
 tablet: [['rect',7,10,70,63,8],['rect',15,18,54,45,3],['circle',42,68,1]],
 lock: [['rect',13,33,58,44,8],['path','M 25 33 L 25 20 Q 42 -5 59 20 L 59 33'],['circle',42,51,4],['path','M 42 55 L 42 64']],
 tank: [['ellipse',42,16,29,11],['path','M 13 16 L 13 66 Q 42 84 71 66 L 71 16 M 13 37 Q 42 55 71 37']],
 ticket: [['path','M 6 15 L 78 15 L 78 34 Q 61 42 78 50 L 78 69 L 6 69 L 6 50 Q 23 42 6 34 Z M 53 25 L 53 59']],
 golf: [['path','M 10 74 L 75 74 M 48 61 L 48 7 L 74 17 L 48 29 M 16 67 L 16 72'],['circle',16,63,4]],
 road: [['path','M 11 78 L 29 8 M 73 78 L 55 8 M 42 69 L 42 58 M 42 43 L 42 34 M 42 20 L 42 11']],
 mirror: [['ellipse',42,34,30,27],['path','M 42 61 L 42 77 M 27 77 L 57 77 M 25 34 L 40 19 M 35 44 L 58 21']],
 flower: [['path','M 42 77 L 42 42 M 42 65 Q 9 65 14 48 Q 36 44 42 65 M 42 56 Q 75 55 69 39 Q 50 37 42 56'],['circle',42,25,18],['circle',42,25,7]],
 stamp: [['path','M 16 56 L 68 56 L 73 72 L 11 72 Z M 27 56 L 30 41 Q 14 11 42 7 Q 71 11 54 41 L 57 56']],
 bulb: [['path','M 28 56 C -2 24 23 2 42 5 C 65 2 86 28 56 56 L 56 67 L 28 67 Z M 30 77 L 54 77 M 42 55 L 42 32']],
 magnify: [['circle',34,32,24],['path','M 51 49 L 77 75 M 23 32 L 45 32 M 34 21 L 34 43']],
 ribbon: [['circle',42,28,23],['path','M 25 46 L 16 78 L 34 69 L 42 78 L 49 48 M 49 48 L 68 78 L 66 49']],
 antenna: [['path','M 42 37 L 20 78 M 42 37 L 64 78 M 29 61 L 55 61 M 30 21 Q 18 37 30 50 M 54 21 Q 66 37 54 50'],['circle',42,36,5]],
 stop: [['polygon',[24,7,59,7,77,25,77,59,59,77,24,77,7,59,7,25]],['path','M 27 27 L 57 57 M 57 27 L 27 57']],
 balance: [['path','M 42 8 L 42 74 M 13 74 L 71 74 M 12 25 L 72 25 M 19 25 L 7 52 L 31 52 Z M 65 25 L 53 52 L 77 52 Z']],
 hamster: [['circle',42,42,28],['circle',22,16,12],['circle',62,16,12],['path','M 29 38 L 30 38 M 54 38 L 55 38 M 35 55 Q 42 62 49 55']],
};
const pathAt = (d,x,y,s) => {
 let axis=0;
 return d.replace(/[MLCQZ]|-?\d+(?:\.\d+)?/g, token=> {
  if (/^[MLCQZ]$/.test(token)) {axis=0;return token;}
  return String(Math.round((Number(token)*s + (axis++%2 ? y:x))*100)/100);
 });
};
export function drawObject(kind,x,y,size,evidence,order=0,variant=0) {
 const shape=shapes[kind]; if(!shape) throw new Error(`Unknown drawing: ${kind}`);
 const s=size/84;
 return shape.map((a,i)=>{
  const type=a[0];let el;
  if(type==='path') el={type,d:pathAt(a[1],x,y,s)};
  if(type==='polygon') el={type,points:a[1].map((v,j)=>+(v*s+(j%2?y:x)).toFixed(2))};
  if(type==='rect') el={type,x:x+a[1]*s,y:y+a[2]*s,width:a[3]*s,height:a[4]*s,rx:a[5]*s};
  if(type==='circle') el={type,cx:x+a[1]*s,cy:y+a[2]*s,r:a[3]*s};
  if(type==='ellipse') el={type,cx:x+a[1]*s,cy:y+a[2]*s,rx:a[3]*s,ry:a[4]*s};
  const solid=i===0 && ['rect','circle','polygon'].includes(type);
  const direction=order%2?-1:1;
  return {...el,evidence,fill:solid?'accent':'none',stroke:'ink',strokeWidth:2.4,
   frames:[{t:0,x:direction*(order?12:0),y:order?5:0,opacity:order?.35:1},
    {t:.32+order*.09,x:0,y:0,opacity:1},
    {t:.72,x:0,y:(variant%2?-2:2)*(i===0?1:.5),opacity:1},
    {t:1,x:0,y:0,opacity:1}]};
 });
}
export function makeDrawing(spec,text,variation=0) {
 const objects=spec.split(';').map(bit=>{
  const [kind,...rest]=bit.trim().split(':');
  const candidates=rest.join(':').split('|');
  const found=candidates.map(q=>{
   const escaped=q.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
   const m=text.match(new RegExp(`(?<![\\p{L}\\p{N}])${escaped}${q.length<=2?'(?![\\p{L}\\p{N}])':''}`,'iu'));
   return {q,at:m?.index ?? -1};
  }).find(q=>q.at>=0);
  if(!found) return null;
  let end=found.at+found.q.length;
  while(end<text.length && (/[\p{L}\p{N}-]/u.test(text[end]) || text[end]==='.' && /\d/.test(text[end+1] || ''))) end++;
  return {kind,evidence:text.slice(found.at,end)};
 }).filter(Boolean);
 if(objects.length<2) throw new Error(`Need two supported visual objects: ${spec} :: ${text.slice(0,100)}`);
 const n=Math.min(3,objects.length), size=n===1?115:n===2?100:78;
 const places=n===1?[[122,40]]:n===2?[[50,49],[210,65]]:[[26,66],[141,42],[252,73]];
 const elements=objects.slice(0,n).flatMap((obj,i)=>{
  const [x,y]=places[i];
  return [{type:'ellipse',cx:x+size/2,cy:167,rx:size*.42,ry:3,evidence:obj.evidence,fill:'muted',stroke:'none',strokeWidth:0,
   frames:[{t:0,opacity:.12},{t:.5,opacity:.18},{t:1,opacity:.12}]},...drawObject(obj.kind,x,y,size,obj.evidence,i,variation)];
 });
 // Labels identify objects; figures never become unsupported charts or orphan stats.
 objects.slice(0,n).forEach((obj,i)=>{
  if(obj.evidence.length>28 || obj.evidence.length<3 || !/[\p{L}]/u.test(obj.evidence)) return;
  elements.push({type:'label',x:places[i][0]+size/2,y:n===3?173+(i%2)*16:184+(i%2)*17,text:obj.evidence,evidence:obj.evidence,role:'ui',frames:[{t:0,opacity:i?.45:1},{t:.5,opacity:1},{t:1,opacity:1}]});
 });
 return {version:1,elements};
}

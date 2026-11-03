import {PNG} from 'pngjs';

// Remove only pale paper connected to the canvas edge. Enclosed white objects
// (newspapers, labels, eyes) remain artwork, not background. Originals stay intact.
export function transparentPaper(bytes){
 const image=PNG.sync.read(bytes,{checkCRC:true}),{width,height,data}=image;
 if(width*height>4e6)throw Error('Illustration exceeds paper-processing limit');
 const edge=[];
 for(let x=0;x<width;x++){edge.push(x,(height-1)*width+x);}
 for(let y=1;y<height-1;y++){edge.push(y*width,y*width+width-1);}
 const pale=i=>{const o=i*4,r=data[o],g=data[o+1],b=data[o+2];return data[o+3]>240&&Math.min(r,g,b)>=205&&Math.max(r,g,b)-Math.min(r,g,b)<=60;};
 const samples=edge.filter(pale);
 if(samples.length<edge.length*.8)return{bytes,processed:false};
 const paper=[0,1,2].map(c=>{const values=samples.map(i=>data[i*4+c]).sort((a,b)=>a-b);return values[Math.floor(values.length/2)];});
 const matches=i=>{const o=i*4;return data[o+3]===0||(Math.min(data[o],data[o+1],data[o+2])>=190&&paper.every((v,c)=>Math.abs(data[o+c]-v)<=36));};
 const removed=new Uint8Array(width*height),queue=new Int32Array(width*height);let head=0,tail=0;
 const visit=i=>{if(!removed[i]&&matches(i)){removed[i]=1;queue[tail++]=i;}};
 for(const i of edge)visit(i);
 while(head<tail){const i=queue[head++],x=i%width;if(x>0)visit(i-1);if(x<width-1)visit(i+1);if(i>=width)visit(i-width);if(i+width<removed.length)visit(i+width);}
 // Unmatte the antialiased rim, so a pale halo doesn't replace the rectangle.
 for(let i=0;i<removed.length;i++){
  const o=i*4;if(removed[i]){data[o+3]=0;continue;}
  const x=i%width;
  const border=(x>0&&removed[i-1])||(x<width-1&&removed[i+1])||(i>=width&&removed[i-width])||(i+width<removed.length&&removed[i+width]);
  if(!border||data[o+3]===0)continue;
  const alpha=Math.max(...paper.map((v,c)=>Math.max(0,(v-data[o+c])/Math.max(1,v))));
  if(alpha<=.02||alpha>=.85)continue;
  for(let c=0;c<3;c++)data[o+c]=Math.max(0,Math.min(255,Math.round((data[o+c]-(1-alpha)*paper[c])/alpha)));
  data[o+3]=Math.round(data[o+3]*alpha);
 }
 return{bytes:PNG.sync.write(image),processed:true};
}

export function createPaperCache(readBytes,{maxBytes=24*1024*1024}={}){
 const ready=new Map(),pending=new Map();let retained=0;
 return async id=>{
  if(ready.has(id)){const value=ready.get(id);ready.delete(id);ready.set(id,value);return value;}
  if(pending.has(id))return pending.get(id);
  const request=(async()=>{const bytes=await readBytes(id);if(!bytes)return null;const value=transparentPaper(bytes);
   if(value.bytes.length<=maxBytes){while(retained+value.bytes.length>maxBytes&&ready.size){const oldest=ready.keys().next().value;retained-=ready.get(oldest).bytes.length;ready.delete(oldest);}ready.set(id,value);retained+=value.bytes.length;}return value;
  })();pending.set(id,request);
  try{return await request;}finally{pending.delete(id);}
 };
}

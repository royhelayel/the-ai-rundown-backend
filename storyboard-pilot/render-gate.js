import{Resvg}from'@resvg/resvg-js';import{fileURLToPath}from'node:url';
import{shotSvg,wrap}from'./staged-render.js';
const fontFiles=[fileURLToPath(new URL('./fonts/Inter.ttf',import.meta.url))];
export function raster(svg){return new Resvg(svg,{font:{fontFiles,loadSystemFonts:false,defaultFontFamily:'Inter'},background:'#f0edf8'}).render();}
export function pixelChange(a,b){let changes=0;for(let i=0;i<a.length;i+=4)if(Math.abs(a[i]-b[i])+Math.abs(a[i+1]-b[i+1])+Math.abs(a[i+2]-b[i+2])>45)changes++;return changes/(a.length/4);}
export function fitArtwork(plan){for(let index=0;index<plan.shots.length;index++){const shot=plan.shots[index];if(shot.chart||shot.artTransform)continue;const boxes=Array.from({length:17},(_,i)=>new Resvg(shotSvg(plan,index,i/16,{labels:false}),{font:{loadSystemFonts:false}}).getBBox()).filter(Boolean);if(!boxes.length)continue;const left=Math.min(...boxes.map(b=>b.x)),top=Math.min(...boxes.map(b=>b.y)),right=Math.max(...boxes.map(b=>b.x+b.width)),bottom=Math.max(...boxes.map(b=>b.y+b.height));const scale=Math.min(1,550/Math.max(1,right-left),260/Math.max(1,bottom-top));shot.artTransform={scale,x:300-(left+right)/2*scale,y:155-(top+bottom)/2*scale};}return plan;}
export function renderGate(plan){fitArtwork(plan);const cells=[],metrics=[];for(let i=0;i<plan.shots.length;i++){
 for(const l of plan.shots[i].labels){const lines=wrap(plan.labels[l.label].text,l.width);if(lines.length>3||l.x-l.width/2<14||l.x+l.width/2>586||l.y+(lines.length-1)*28+7>420)throw Error('Shot '+(i+1)+' label does not fit safely: '+plan.labels[l.label].text);}
 const times=[0,.45,.9];const images=times.map(t=>raster(shotSvg(plan,i,t)));const art=times.map(t=>raster(shotSvg(plan,i,t,{labels:false})).pixels);const delta=Math.max(pixelChange(art[0],art[1]),pixelChange(art[1],art[2]));metrics.push({shot:i+1,changedPixelFraction:delta});if(delta<.006)throw Error('Shot '+(i+1)+' has barely visible rendered movement; move or transform a large recognisable object, not just fade/rotate an invisible or symmetric mark');
 for(let j=0;j<3;j++)cells.push(`<image x="${j*600}" y="${i*460+40}" width="600" height="420" href="data:image/png;base64,${images[j].asPng().toString('base64')}"/>`);
 }
 const headers=plan.shots.map((_,i)=>`<text x="18" y="${i*460+27}" font-family="Inter" font-size="20" fill="#24301f">SHOT ${i+1} · SETUP / ACTION / RESULT</text>`).join('');const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="1800" height="${plan.shots.length*460}" viewBox="0 0 1800 ${plan.shots.length*460}">${headers}${cells.join('')}</svg>`;
 return{metrics,png:raster(svg).asPng()};
}

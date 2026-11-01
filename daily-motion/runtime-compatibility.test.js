import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import * as Remotion from 'remotion';
import { installSceneCompatibility } from './runtime-compatibility.js';
test('legacy smooth easing and numeric geometry work without changing labels or DOM props', () => {
 const runtime = { React, Remotion: { ...Remotion, Easing: { ...Remotion.Easing } } };
 installSceneCompatibility(runtime);
 assert.equal(runtime.Remotion.Easing.smooth(0),0);
 assert.equal(runtime.Remotion.Easing.smooth(.5),.5);
 assert.equal(runtime.Remotion.Easing.smooth(1),1);
 const make = runtime.React.createElement;
 const Burst = ({cx,cy,label}) => make('svg',null,make('line',{x2:cx+10,y2:cy+20}),make('text',null,label));
 const output = renderToStaticMarkup(make(Burst,{cx:'420',cy:'320',label:'500'}));
 assert.match(output,/x2="430"/);assert.match(output,/y2="340"/);assert.match(output,/>500</);
 assert.equal(make('rect',{x:'10'}).props.x,'10');
 installSceneCompatibility(runtime);assert.equal(runtime.React.createElement,make);
});

test('unknown easing APIs are rejected before publication, including aliased imports', async () => {
 const { validateScene } = await import('./validate.js');
 const code = `import React from 'react'; import {Easing as Ease,useCurrentFrame} from 'remotion'; export default function Story(){const frame=useCurrentFrame();return <svg width="720" height="420"><rect x={Ease.imaginary(frame)} y="100" width="100" height="100" fill="#000"/><text fontSize="32">A news update</text></svg>}`;
 assert.throws(()=>validateScene(code),/Unsupported Remotion Easing method imaginary/);
 assert.equal(validateScene(code.replace('Ease.imaginary','Ease.smooth')),true);
});

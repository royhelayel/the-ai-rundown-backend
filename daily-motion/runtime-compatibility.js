// Older generated assets use these two harmless API/prop conventions. Adapt at
// the runtime boundary so their immutable source and evidence hashes stay intact.
export function installSceneCompatibility(runtime) {
 const easing = runtime.Remotion.Easing;
 if (!easing.smooth) easing.smooth = t => t * t * (3 - 2 * t);
 if (runtime.React.__rnNumericGeometry) return;
 const original = runtime.React.createElement;
 const geometry = new Set(['x','y','cx','cy','x1','x2','y1','y2','width','height','r','rx','ry']);
 runtime.React = { ...runtime.React, __rnNumericGeometry: true, createElement(type, props, ...children) {
  if (typeof type === 'function' && props) {
   props = { ...props };
   for (const key of Object.keys(props)) if (geometry.has(key) && typeof props[key] === 'string' && /^-?(?:\d+\.?\d*|\.\d+)$/.test(props[key])) props[key] = Number(props[key]);
  }
  return original(type, props, ...children);
 } };
}

import test from 'node:test';
import assert from 'node:assert/strict';
import { canvasPoint, pointInLayer, validateProject, resizeBase, checkDimensions, clone } from './model.js';

const fixture = () => ({ type: 'garment-pattern-placement', version: 1, base: { src: '/design-workbench/assets/garment.png', width: 1024, height: 1024, name: '示例' }, layers: [{ id: 'flower-1', name: '花', src: '/design-workbench/assets/flower.svg', x: 500, y: 420, width: 200, aspect: 2, rotation: 90, opacity: .9, blend: 'multiply', visible: true }] });

test('CSS-scaled canvas pointer maps into base-image coordinates', () => {
  assert.deepEqual(canvasPoint(260, 170, { left: 10, top: 20, width: 500, height: 500 }, 1000, 1000), { x: 500, y: 300 });
});
test('rotation-aware hit test uses image center and aspect ratio', () => {
  const layer = fixture().layers[0];
  assert.equal(pointInLayer({ x: 500, y: 510 }, layer), true);
  assert.equal(pointInLayer({ x: 590, y: 420 }, layer), false);
  assert.equal(pointInLayer({ x: 500, y: 420 }, layer), true);
});
test('safe valid project round trips without unwanted fields', () => {
  const project = fixture(); project.untrusted = true;
  const result = validateProject(project);
  assert.equal(result.untrusted, undefined);
  assert.deepEqual(result, fixture());
});
test('invalid sources and untrusted SVG data are rejected', () => {
  for (const src of ['https://example.com/image.png', 'javascript:alert(1)', 'data:image/svg+xml;base64,PHN2Zz4=']) {
    const project = fixture(); project.layers[0].src = src;
    assert.throws(() => validateProject(project));
  }
});
test('import bounds, IDs, layer limit, number validation and blend validation', () => {
  const duplicate = fixture(); duplicate.layers.push({ ...duplicate.layers[0] }); assert.throws(() => validateProject(duplicate));
  const tooMany = fixture(); tooMany.layers = Array.from({ length: 31 }, (_, i) => ({ ...tooMany.layers[0], id: `layer-${i}` })); assert.throws(() => validateProject(tooMany));
  for (const [prop, value] of [['x', Infinity], ['opacity', 2], ['width', -1], ['aspect', 0], ['rotation', 181], ['blend', 'screen'], ['visible', 'true']]) {
    const project = fixture(); project.layers[0][prop] = value; assert.throws(() => validateProject(project));
  }
});
test('base replacement rescales location and width but preserves original object', () => {
  const project = fixture(); const result = resizeBase(project, { src: '/design-workbench/assets/garment.png', name: '新底图', width: 512, height: 2048 });
  assert.equal(result.layers[0].x, 250); assert.equal(result.layers[0].y, 840); assert.equal(result.layers[0].width, 100);
  assert.equal(result.layers[0].aspect, 2); assert.equal(project.layers[0].x, 500);
});
test('base image dimensions are bounded', () => {
  assert.doesNotThrow(() => checkDimensions(1024, 1024));
  for (const dimensions of [[0, 100], [8193, 100], [8192, 8192], [100.5, 100]]) assert.throws(() => checkDimensions(...dimensions));
});
test('history snapshots isolate mutable objects and retain image strings', () => {
  const project = fixture(); const snapshot = clone(project);
  snapshot.layers[0].x = 10;
  assert.equal(project.layers[0].x, 500); assert.equal(snapshot.layers[0].src, project.layers[0].src);
});
test('tiny replacement base keeps width inside the editable/importable range', () => {
  const result = resizeBase(fixture(), { src: '/design-workbench/assets/garment.png', name: 'tiny', width: 1, height: 1 });
  assert.equal(result.layers[0].width, 1); assert.doesNotThrow(() => validateProject(result));
});

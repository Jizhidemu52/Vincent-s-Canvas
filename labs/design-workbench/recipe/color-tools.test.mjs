import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_PALETTE, makeColor, normalizePalette, generatePalette, recolorImageData } from './color-tools.mjs';

test('旧配方自动补默认六色且互不共享可变对象', () => {
  const palette = normalizePalette();
  assert.equal(palette.length, 6);
  palette[0].name = '修改';
  assert.equal(DEFAULT_PALETTE[0].name, '雾青');
  assert.equal(normalizePalette()[0].name, '雾青');
});

test('HEX 输入大小写、短码、不带井号及非法输入', () => {
  assert.equal(makeColor(' #ABC ').hex, '#aabbcc');
  assert.equal(makeColor('FF0000').hex, '#ff0000');
  for (const invalid of ['red', '#abcd', '#12345678', 'url(x)', '', '15-4201 TCX']) assert.throws(() => makeColor(invalid), /请输入有效/);
});

test('保存数据校验，不将损坏或假潘通色号变成已匹配颜色', () => {
  assert.throws(() => normalizePalette({}), /配色数据无效/);
  assert.throws(() => normalizePalette([{ hex: 'invalid' }]), /请输入有效/);
  const color = makeColor('#123456', { source: 'pantone', pantoneCode: '12-3456 TCX' });
  assert.equal(color.source, 'manual');
  assert.equal(color.pantoneCode, null);
  assert.equal(color.approximate, true);
});

function seeded(seed) { let n = seed; return () => { n = (Math.imul(n, 1664525) + 1013904223) >>> 0; return n / 4294967296; }; }
for (const style of ['soft', 'vivid', 'earth', 'free']) {
  test(`${style} 随机风格生成一至六个合法且不重复的数字色，固定输入可复验`, () => {
    for (let count = 1; count <= 6; count++) {
      const colors = generatePalette(count, style, seeded(2026 + count));
      assert.equal(colors.length, count);
      assert.equal(new Set(colors.map(x => x.hex)).size, count);
      assert.ok(colors.every(x => /^#[0-9a-f]{6}$/.test(x.hex) && x.source === 'random' && !x.pantoneCode));
      assert.deepEqual(colors, generatePalette(count, style, seeded(2026 + count)));
    }
  });
}

const makePixels = () => ({ width: 3, height: 1, data: new Uint8ClampedArray([90, 160, 210, 255, 255, 255, 255, 255, 210, 80, 80, 0]) });
test('选色实际改变彩色像素，同时保留白背景和透明像素', () => {
  const red = recolorImageData(makePixels(), '#ee2222');
  const blue = recolorImageData(makePixels(), '#2222ee');
  assert.ok(red.data[0] > red.data[2]);
  assert.ok(blue.data[2] > blue.data[0]);
  assert.notDeepEqual([...red.data.slice(0, 3)], [...blue.data.slice(0, 3)]);
  assert.deepEqual([...red.data.slice(4)], [...makePixels().data.slice(4)]);
});
test('黑白灰具有不同明度，灰色不产生彩色色偏', () => {
  const black = recolorImageData(makePixels(), '#000000');
  const white = recolorImageData(makePixels(), '#ffffff');
  const grey = recolorImageData(makePixels(), '#777777');
  assert.ok(white.data[0] - black.data[0] > 220);
  assert.equal(grey.data[0], grey.data[1]);
  assert.equal(grey.data[1], grey.data[2]);
});

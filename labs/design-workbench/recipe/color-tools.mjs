import chroma from './vendor/chroma-js/chroma.mjs';

export const DEFAULT_PALETTE = Object.freeze([
  { name: '雾青', hex: '#91a8a1' }, { name: '沙杏', hex: '#cfb799' },
  { name: '陶粉', hex: '#b9827b' }, { name: '鼠尾草', hex: '#9da882' },
  { name: '暮蓝', hex: '#8295ad' }, { name: '烟紫', hex: '#a19aae' },
].map(color => Object.freeze({ ...color, source: 'preset', pantoneCode: null, library: null, approximate: true })));

export function makeColor(value, metadata = {}) {
  const text = String(value ?? '').trim();
  if (!/^#?(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(text)) throw new Error('请输入有效的十六进制颜色，例如 #91A8A1。');
  const hex = chroma(text.startsWith('#') ? text : '#' + text).hex().toLowerCase();
  return {
    name: String(metadata.name || '自选色').slice(0, 60), hex,
    source: ['preset', 'manual', 'random'].includes(metadata.source) ? metadata.source : 'manual',
    pantoneCode: null, library: null, approximate: true,
  };
}

export function normalizePalette(input) {
  if (input === undefined) return DEFAULT_PALETTE.map(color => ({ ...color }));
  if (!Array.isArray(input) || input.length > 6) throw new Error('配色数据无效，应为最多六个颜色。');
  return DEFAULT_PALETTE.map((fallback, index) => {
    const color = input[index];
    if (color === undefined) return { ...fallback };
    if (!color || typeof color !== 'object') throw new Error('保存的配色内容无效。');
    return makeColor(color.hex, color);
  });
}

export function generatePalette(count, style = 'soft', random = Math.random) {
  if (!['soft', 'vivid', 'earth', 'free'].includes(style)) throw new Error('请选择有效的随机配色风格。');
  const amount = Math.max(1, Math.min(6, Math.round(Number(count) || 3)));
  const pick = (min, max) => min + Math.max(0, Math.min(0.999999, random())) * (max - min);
  const hue = style === 'earth' ? pick(28, 65) : pick(0, 360);
  const offsets = style === 'earth' ? [0, 30, 72, -15, 110, 45] : style === 'vivid' ? [0, 180, 60, 240, 120, 300] : [0, 38, -38, 180, 142, 218];
  const lightness = style === 'soft' ? [.69, .88] : style === 'vivid' ? [.52, .73] : style === 'earth' ? [.38, .75] : [.32, .89];
  const chromaRange = style === 'soft' ? [.04, .09] : style === 'vivid' ? [.15, .23] : style === 'earth' ? [.035, .10] : [.03, .22];
  const names = { soft: '柔和', vivid: '鲜明', earth: '大地', free: '自由' };
  const colors = [];
  for (let index = 0; index < amount; index++) {
    let color;
    for (let attempt = 0; attempt < 24; attempt++) {
      const h = style === 'free' ? pick(0, 360) : (hue + offsets[index] + pick(-8, 8) + 360) % 360;
      color = chroma.oklch(pick(...lightness), pick(...chromaRange), h);
      if (colors.every(prior => chroma.deltaE(prior.hex, color) >= 9)) break;
    }
    // Each generated candidate is a real digital color, never an invented Pantone match.
    colors.push(makeColor(color.hex(), { name: `${names[style]} ${String(index + 1).padStart(2, '0')}`, source: 'random' }));
  }
  return colors;
}

/** Local, non-semantic recoloring. White/grey background pixels remain unchanged. */
export function recolorImageData(imageData, hex) {
  if (!imageData?.data || imageData.data.length % 4 !== 0) throw new Error('无法读取图像像素。');
  const target = chroma(makeColor(hex).hex);
  const [targetHue, targetSaturation, targetLight] = target.hsl();
  const data = imageData.data;
  const histogram = new Uint32Array(256);
  const mask = new Uint8Array(data.length / 4);
  let affected = 0;
  for (let p = 0; p < data.length; p += 4) {
    if (data[p + 3] === 0) continue;
    const max = Math.max(data[p], data[p + 1], data[p + 2]) / 255;
    const min = Math.min(data[p], data[p + 1], data[p + 2]) / 255;
    const light = (max + min) / 2;
    const saturation = max === min ? 0 : (max - min) / (1 - Math.abs(2 * light - 1));
    if (saturation > .13 && light > .07 && light < .94) {
      mask[p / 4] = 1;
      histogram[Math.round(light * 255)]++;
      affected++;
    }
  }
  if (!affected) return imageData;
  let sum = 0, median = 0;
  for (; median < 255; median++) { sum += histogram[median]; if (sum >= affected / 2) break; }
  const referenceLight = median / 255;
  // Use the selected color's saturation AND lightness; black, white and grey are not hue-only aliases.
  const lut = Array.from({ length: 256 }, (_, index) => {
    const light = Math.max(.015, Math.min(.985, targetLight + (index / 255 - referenceLight) * .78));
    return chroma.hsl(Number.isFinite(targetHue) ? targetHue : 0, targetSaturation || 0, light).rgb();
  });
  for (let p = 0; p < data.length; p += 4) {
    if (!mask[p / 4]) continue;
    const light = Math.round((Math.max(data[p], data[p + 1], data[p + 2]) + Math.min(data[p], data[p + 1], data[p + 2])) / 2);
    [data[p], data[p + 1], data[p + 2]] = lut[light];
  }
  return imageData;
}

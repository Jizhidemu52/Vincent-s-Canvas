export const PROJECT_VERSION = 1;
export const MAX_LAYERS = 30;
export const BUILTIN_ASSETS = ['/assets/flower.svg', '/assets/leaf.svg', '/assets/brand.svg'];
export const MAX_PIXELS = 32000000;

export const clone = value => value === null || typeof value !== 'object' ? value : Array.isArray(value) ? value.map(clone) : Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clone(item)]));
export const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

export function canvasPoint(clientX, clientY, rect, width, height) {
  return { x: (clientX - rect.left) * width / rect.width, y: (clientY - rect.top) * height / rect.height };
}

export function pointInLayer(point, layer) {
  const radians = -layer.rotation * Math.PI / 180;
  const dx = point.x - layer.x;
  const dy = point.y - layer.y;
  const x = dx * Math.cos(radians) - dy * Math.sin(radians);
  const y = dx * Math.sin(radians) + dy * Math.cos(radians);
  return Math.abs(x) <= layer.width / 2 && Math.abs(y) <= layer.width / layer.aspect / 2;
}

export function checkDimensions(width, height) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > 8192 || height > 8192 || width * height > MAX_PIXELS) {
    throw new Error('图片尺寸需在 8192 × 8192 以内，且总像素不超过 3200 万。');
  }
}

function validSource(src, base = false) {
  if (typeof src !== 'string' || src.length > 23000000) return false;
  if (base && src === '/assets/garment.png') return true;
  if (!base && BUILTIN_ASSETS.includes(src)) return true;
  return /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(src);
}

function number(value, min, max, name) {
  if (!Number.isFinite(value) || value < min || value > max) throw new Error(`工程中的${name}超出允许范围。`);
  return value;
}

function label(value, fallback) {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, 80) : fallback;
}

export function validateProject(input) {
  if (!input || input.type !== 'garment-placement-demo' || input.version !== PROJECT_VERSION) throw new Error('不是此 Demo 支持的工程文件。');
  const b = input.base;
  if (!b || !validSource(b.src, true)) throw new Error('底图必须是内置示例或嵌入的 PNG / JPEG / WebP 图片。');
  checkDimensions(b.width, b.height);
  if (!Array.isArray(input.layers) || input.layers.length > MAX_LAYERS) throw new Error(`工程最多支持 ${MAX_LAYERS} 个图案图层。`);
  const ids = new Set();
  const layers = input.layers.map((layer, index) => {
    if (!layer || typeof layer.id !== 'string' || !/^[\w-]{1,80}$/.test(layer.id) || ids.has(layer.id)) throw new Error('工程图层标识无效或重复。');
    ids.add(layer.id);
    if (!validSource(layer.src)) throw new Error('图案必须是内置素材或嵌入的 PNG / JPEG / WebP 图片。');
    if (!['source-over', 'multiply'].includes(layer.blend)) throw new Error('不支持该图层混合模式。');
    if (typeof layer.visible !== 'boolean') throw new Error('图层显示状态无效。');
    return {
      id: layer.id, name: label(layer.name, `图案 ${index + 1}`), src: layer.src,
      x: number(layer.x, -b.width, b.width * 2, '横向位置'),
      y: number(layer.y, -b.height, b.height * 2, '纵向位置'),
      width: number(layer.width, 1, b.width * 2, '图案宽度'),
      aspect: number(layer.aspect, 1 / 8192, 8192, '图案比例'),
      rotation: number(layer.rotation, -180, 180, '旋转角度'),
      opacity: number(layer.opacity, 0, 1, '透明度'), blend: layer.blend, visible: layer.visible,
    };
  });
  return { type: 'garment-placement-demo', version: PROJECT_VERSION, base: { src: b.src, width: b.width, height: b.height, name: label(b.name, '服装底图') }, layers };
}

export function resizeBase(project, base) {
  const sx = base.width / project.base.width;
  const sy = base.height / project.base.height;
  return { ...project, base, layers: project.layers.map(layer => ({ ...layer, x: layer.x * sx, y: layer.y * sy, width: clamp(layer.width * sx, 1, base.width * 2) })) };
}

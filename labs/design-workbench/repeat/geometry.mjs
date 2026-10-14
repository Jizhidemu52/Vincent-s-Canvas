/** Deterministic repeat geometry. Positions are fractions of the design unit. */
export const MODES = Object.freeze({ straight: '直排', half: '半落', mirror: '镜像' });
export const MAX_EDGE = 4096;
export const MAX_PIXELS = 16_000_000;

export function cmToPx(cm, dpi) {
  if (!Number.isFinite(cm) || !Number.isFinite(dpi) || cm <= 0 || dpi <= 0) {
    throw new Error('尺寸和 DPI 必须大于 0');
  }
  return Math.max(1, Math.round(cm / 2.54 * dpi));
}

export function periodSize(width, height, mode) {
  return { width: width * (mode === 'straight' ? 1 : 2), height: height * (mode === 'mirror' ? 2 : 1) };
}

export function validateExport(width, height, mode) {
  const period = periodSize(width, height, mode);
  return { ...period, valid: period.width <= MAX_EDGE && period.height <= MAX_EDGE && period.width * period.height <= MAX_PIXELS };
}

export function wrapPosition(x, y, mode = 'straight') {
  const column = Math.floor(x);
  // The half-drop lattice has basis vectors (W,H/2), (0,H).
  if (mode === 'half') y -= column * 0.5;
  return { x: x - column, y: y - Math.floor(y) };
}

export function elementSize(item, width) {
  const w = width * item.size;
  return { width: w, height: w / (item.ratio || 1) };
}

/** Visible translated instances, including the copies crossing a unit border. */
export function latticeCopies(item, unitWidth, unitHeight, fieldWidth = unitWidth, fieldHeight = unitHeight, mode = 'straight') {
  const size = elementSize(item, unitWidth);
  const radius = Math.hypot(size.width, size.height) / 2;
  const cx = item.x * unitWidth;
  const cy = item.y * unitHeight;
  const copies = [];
  const firstColumn = Math.floor((-radius - cx) / unitWidth);
  const lastColumn = Math.ceil((fieldWidth + radius - cx) / unitWidth);
  for (let column = firstColumn; column <= lastColumn; column++) {
    const x = cx + column * unitWidth;
    const shift = mode === 'half' ? column * unitHeight / 2 : 0;
    const firstRow = Math.floor((-radius - cy - shift) / unitHeight);
    const lastRow = Math.ceil((fieldHeight + radius - cy - shift) / unitHeight);
    for (let row = firstRow; row <= lastRow; row++) {
      const y = cy + row * unitHeight + shift;
      if (x + radius >= 0 && x - radius <= fieldWidth && y + radius >= 0 && y - radius <= fieldHeight) {
        copies.push({ x, y, column, row, ...size });
      }
    }
  }
  return copies;
}

export function mirrorCellTransform(column, row, width, height) {
  const flipX = Math.abs(column % 2) === 1;
  const flipY = Math.abs(row % 2) === 1;
  return { x: (column + (flipX ? 1 : 0)) * width, y: (row + (flipY ? 1 : 0)) * height, scaleX: flipX ? -1 : 1, scaleY: flipY ? -1 : 1 };
}

export function hitElement(point, copy, angle) {
  const rad = -angle * Math.PI / 180;
  const dx = point.x - copy.x;
  const dy = point.y - copy.y;
  const x = dx * Math.cos(rad) - dy * Math.sin(rad);
  const y = dx * Math.sin(rad) + dy * Math.cos(rad);
  return Math.abs(x) <= copy.width / 2 && Math.abs(y) <= copy.height / 2;
}

export function previewSize(unitWidth, unitHeight, maxEdge = 1600) {
  const scale = Math.min(1, maxEdge / (unitWidth * 3), maxEdge / (unitHeight * 3));
  return { width: Math.max(1, Math.round(unitWidth * 3 * scale)), height: Math.max(1, Math.round(unitHeight * 3 * scale)), scale };
}

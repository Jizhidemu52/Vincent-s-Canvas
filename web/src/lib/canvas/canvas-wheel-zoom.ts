const MAX_WHEEL_DELTA = 192;

/** 25% more input gain, without a minimum step that would amplify tiny trackpad deltas. */
export function canvasWheelZoomFactor(deltaY: number, deltaMode = 0, pageHeight = 800) {
    if (!Number.isFinite(deltaY)) return 1;
    const pixels = deltaY * (deltaMode === 1 ? 16 : deltaMode === 2 ? pageHeight : 1);
    const boundedDelta = Math.max(-MAX_WHEEL_DELTA, Math.min(MAX_WHEEL_DELTA, -pixels));
    return Math.pow(2, boundedDelta / 240);
}

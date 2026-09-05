const MAX_WHEEL_DELTA = 160;

/** Limits one noisy wheel event while preserving the existing zoom curve. */
export function canvasWheelZoomFactor(deltaY: number) {
    const boundedDelta = Math.max(-MAX_WHEEL_DELTA, Math.min(MAX_WHEEL_DELTA, -deltaY));
    return Math.pow(1.1, boundedDelta / 100);
}

/**
 * Canvas layers are write-only previews. Ask supporting browsers to present
 * their path updates without synchronizing with a compositor frame; engines
 * that do not support the hint simply return a normal 2D context.
 */
export const fastCanvas2DContextOptions: CanvasRenderingContext2DSettings = { desynchronized: true };

export function getFastCanvas2DContext(canvas: HTMLCanvasElement) {
    return canvas.getContext("2d", fastCanvas2DContextOptions);
}

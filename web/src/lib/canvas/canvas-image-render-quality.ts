/**
 * Let the browser prioritize images already in the viewport while keeping
 * large offscreen canvas image sets from competing with pointer interaction.
 */
export function canvasImageRenderProps() {
    return { decoding: "async" as const, loading: "lazy" as const };
}

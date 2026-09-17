declare module "imagetracerjs" {
    const tracer: {
        imagedataToSVG(image: { width: number; height: number; data: Uint8ClampedArray }, options?: Record<string, unknown>): string;
    };
    export default tracer;
}

import { traceLineArt, type TraceOptions } from "./line-trace";
import type { PixelImage } from "./image-processing";

self.onmessage = (event: MessageEvent<{ image: PixelImage; options: TraceOptions }>) => {
    try { self.postMessage({ svg: traceLineArt(event.data.image, event.data.options) }); }
    catch (error) { self.postMessage({ error: error instanceof Error ? error.message : "矢量描摹失败" }); }
};

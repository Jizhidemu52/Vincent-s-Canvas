import { executeVectorTrace, type VectorTraceTask } from "./pattern-trace";

self.onmessage = (event: MessageEvent<VectorTraceTask>) => {
    try { self.postMessage({ result: executeVectorTrace(event.data) }); }
    catch (error) { self.postMessage({ error: error instanceof Error ? error.message : "矢量描摹失败" }); }
};

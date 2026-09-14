// Browser-only benchmark bundle; never imported by the application.
import { useCanvasStore, flushCanvasPersistence } from "../src/stores/canvas/use-canvas-store";
import { readCanvasProjects } from "../src/lib/canvas/canvas-project-storage";

Object.assign(window, { architectureLab: {
    store: useCanvasStore,
    flush: flushCanvasPersistence,
    read: () => readCanvasProjects("wireless-canvas:canvas_store"),
} });

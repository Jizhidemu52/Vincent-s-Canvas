import type { CanvasProject } from "@/stores/canvas/use-canvas-store";
import type { EncodedCanvasProject } from "@/lib/canvas/canvas-project-codec";

export type CanvasExportFile = {
    app: "wireless-canvas";
    version: 3;
    exportedAt: string;
    projects: CanvasProjectExportItem[];
};

export type CanvasProjectExportItem = {
    project: CanvasProject | EncodedCanvasProject;
    files: CanvasExportAsset[];
};

export type CanvasExportAsset = {
    storageKey: string;
    path: string;
    mimeType: string;
    bytes: number;
};

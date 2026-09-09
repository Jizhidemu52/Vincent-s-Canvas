export type ReferenceImage = {
    originalFileName?: string;
    imageName?: string;
    imageVersion?: number;
    id: string;
    name: string;
    type: string;
    dataUrl: string;
    url?: string;
    storageKey?: string;
    sourceAssetId?: string;
    bytes?: number;
    width?: number;
    height?: number;
};

export type ImageReferenceOrigin = "upload" | "asset" | "canvas" | "connection" | "clipboard" | "generated" | "template";

export type ImageReferenceItem = ReferenceImage & {
    referenceKey: string;
    origin: ImageReferenceOrigin;
    originLabel: string;
};

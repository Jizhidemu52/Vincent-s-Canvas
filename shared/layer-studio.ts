/** Public, provider-neutral result contract for the dedicated layer workspace. */
export const LAYER_STUDIO_TOOL = "layer-studio" as const;
export const LAYER_STUDIO_LABEL = "图层拆分与图片生成";
export type LayerStudioMode = "generate" | "decompose";
export type LayerStudioBox = [number, number, number, number];
export type LayerStudioBoundingBox = {
  absolute?: LayerStudioBox;
  normalized?: LayerStudioBox;
};
export type LayerStudioOcr = {
  text?: string;
  lines?: Array<{
    boundingBox?: LayerStudioBoundingBox;
    runs?: Array<{
      text?: string;
      style?: {
        similarFontFamily?: string;
        foregroundColor?: string;
        bold?: boolean;
        italic?: boolean;
        underline?: boolean;
        strikethrough?: boolean;
        shadow?: boolean;
        translucent?: boolean;
      };
    }>;
  }>;
};
export type LayerStudioItem = {
  index: number;
  groupIndex: number;
  urlIndex: number;
  role: "image" | "base" | "layer";
  state: "pending" | "saved";
  assetId?: string;
  contentUrl?: string;
  width?: number;
  height?: number;
  mimeType?: string;
  sha256?: string;
  name?: string;
  description?: string;
  zIndex?: number;
  background?: "opaque" | "transparent";
  boundingBox?: LayerStudioBoundingBox;
  textRecognition?: LayerStudioOcr;
};
export type LayerStudioResultDocument = {
  version: 1;
  taskId: string;
  mode: LayerStudioMode;
  status: "persisting" | "partial" | "ready";
  expectedOutputCount: number;
  items: LayerStudioItem[];
};

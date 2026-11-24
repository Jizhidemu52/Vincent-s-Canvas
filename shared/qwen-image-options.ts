export const QWEN_IMAGE_MODEL = "qwen-image-3.0";
export const QWEN_IMAGE_RATIOS = ["1:1", "4:3", "3:4", "16:9", "9:16", "3:2", "2:3"] as const;
export const QWEN_IMAGE_REFERENCE_LIMIT = 3;
export const QWEN_IMAGE_REFERENCE_MAX_BYTES = 10 * 1024 * 1024;
export const QWEN_IMAGE_REFERENCE_MIMES = ["image/jpeg", "image/png", "image/webp", "image/bmp", "image/tiff", "image/gif"] as const;
export const QWEN_IMAGE_MIN_EDGE = 512;
export const QWEN_IMAGE_MAX_EDGE = 2048;

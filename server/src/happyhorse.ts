export type HappyHorseImageSource = {
  mimeType: string;
  bytes: Uint8Array;
};

export function toHappyHorseImageDataUrl(source: HappyHorseImageSource) {
  if (!/^image\/(?:png|jpeg|jpg|webp|bmp)$/i.test(source.mimeType))
    throw new Error("HappyHorse reference image MIME type is invalid");
  if (!source.bytes.byteLength)
    throw new Error("HappyHorse reference image is empty");
  return `data:${source.mimeType};base64,${Buffer.from(source.bytes).toString("base64")}`;
}

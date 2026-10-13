import { detectReferenceImage } from "./reference-import";

/** Provider format requests and response headers can disagree with the bytes.
 * Reuse the existing detector; identifying a format never re-encodes the image.
 * Keep the declared fallback for other result formats this detector does not know.
 */
export function providerImageMimeType(bytes: Uint8Array, declaredMimeType = "image/png") {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return detectReferenceImage(buffer) || declaredMimeType;
}

export function inlineProviderImageDataUrl(base64: string, declaredMimeType = "image/png") {
  const mimeType = providerImageMimeType(Buffer.from(base64, "base64"), declaredMimeType);
  return `data:${mimeType};base64,${base64}`;
}

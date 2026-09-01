export type InlineImageResult = { mimeType: string; bytes: Uint8Array };

export function decodeInlineImageResult(value: string): InlineImageResult | null {
  const match = value.match(/^data:(image\/[a-z0-9.+-]+);base64,([a-z0-9+/=\s]+)$/i);
  if (!match) return null;

  const bytes = Uint8Array.from(Buffer.from(match[2].replace(/\s/g, ""), "base64"));
  return bytes.byteLength ? { mimeType: match[1].toLowerCase(), bytes } : null;
}

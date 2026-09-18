import { expect, test } from "bun:test";
import { cleanSourceUrl, decodeReference, imageMime, isReferenceEnvelope, MAX_IMAGE_BYTES, REFERENCE_CHANNEL } from "../src/pages/reference-import/protocol";
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=";
const payload = { id: "image-1", mime: "image/png", name: "sample.png", base64: png, sourcePage: "https://user:pass@example.org/a?token=secret#secret", sourceImage: "https://example.org/a.png?signature=secret", pageTitle: "来源标题" };
test("original bytes retained and provenance stripped of credentials/query/hash", async () => {
    const { file, payload: clean } = decodeReference(payload);
    expect(Buffer.from(await file.arrayBuffer()).toString("base64")).toBe(png);
    expect(clean.sourcePage).toBe("https://example.org/a");
    expect(clean.sourceImage).toBe("https://example.org/a.png");
    expect(file.type).toBe("image/png");
});
test("malformed messages, unsupported media and oversized images rejected", () => {
    expect(() => decodeReference({ ...payload, base64: "!!!!" })).toThrow();
    expect(() => decodeReference({ ...payload, mime: "image/jpeg" })).toThrow();
    expect(() => decodeReference({ ...payload, id: "../../bad" })).toThrow();
    expect(() => decodeReference({ ...payload, base64: "A".repeat(Math.ceil(MAX_IMAGE_BYTES / 3) * 4 + 4) })).toThrow();
    expect(() => imageMime(new TextEncoder().encode("<svg></svg>"))).toThrow();
    expect(cleanSourceUrl("javascript:alert(1)")).toBe("");
});
test("nonce, channel, request type and id must match", () => {
    const msg = { channel: REFERENCE_CHANNEL, nonce: "nonce", type: "image", requestId: "request-1", image: payload };
    expect(isReferenceEnvelope(msg, "nonce")).toBe(true);
    expect(isReferenceEnvelope(msg, "other")).toBe(false);
    expect(isReferenceEnvelope(msg, "")).toBe(false);
    expect(isReferenceEnvelope({ ...msg, type: "ack" }, "nonce")).toBe(false);
    expect(isReferenceEnvelope({ ...msg, requestId: "x".repeat(81) }, "nonce")).toBe(false);
});

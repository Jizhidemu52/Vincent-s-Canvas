import { expect, test } from "bun:test";
import { AVIF_REFERENCE_UNSUPPORTED_MESSAGE } from "../../shared/generation-error";
import { validateAssetUpload } from "../src/asset-delivery";
import { validateSeedream55Reference } from "../src/seedream55-reference";

test("real AVIF bytes remain uploadable and unchanged while model processing gives a clear notice", async () => {
    const bytes = Buffer.from("AAAAIGZ0eXBhdmlmAAAAAGF2aWZtaWYxbWlhZk1BMUIAAAD5bWV0YQAAAAAAAAAvaGRscgAAAAAAAAAAcGljdAAAAAAAAAAAAAAAAFBpY3R1cmVIYW5kbGVyAAAAAA5waXRtAAAAAAABAAAAHmlsb2MAAAAARAAAAQABAAAAAQAAASEAAAAbAAAAKGlpbmYAAAAAAAEAAAAaaW5mZQIAAAAAAQAAYXYwMUNvbG9yAAAAAGppcHJwAAAAS2lwY28AAAAUaXNwZQAAAAAAAAAgAAAAIAAAABBwaXhpAAAAAAMICAgAAAAMYXYxQ4EADAAAAAATY29scm5jbHgAAgACAAIAAAAAF2lwbWEAAAAAAAAAAQABBAECgwQAAAAjbWRhdAoGGBE/9oAgMhEXgAAASAAAAS2Sf/VWVbUVDA==", "base64");
    const original = Buffer.from(bytes);
    expect(await validateAssetUpload(bytes, "image/avif")).toBe("image/avif");
    await expect(validateSeedream55Reference({ bytes, mimeType: "image/avif" })).rejects.toThrow(AVIF_REFERENCE_UNSUPPORTED_MESSAGE);
    expect(bytes).toEqual(original);
});

import { expect, test } from "bun:test";
import { createAssetThumbnailBytes } from "../src/asset-thumbnails";
import { inspectDesignLibraryImage } from "../src/design-library";
import { png } from "./design-library-fixtures";

test("library asks the existing thumbnail encoder for 256 only; the asset default still returns both sizes", async () => {
    const small = await createAssetThumbnailBytes(png, [256]);
    expect(Object.keys(small)).toEqual(["256"]);
    expect(inspectDesignLibraryImage(small[256], "image/webp")).toMatchObject({ width: 1, height: 1 });
    const standard = await createAssetThumbnailBytes(png);
    expect(Object.keys(standard)).toEqual(["256", "1024"]);
});

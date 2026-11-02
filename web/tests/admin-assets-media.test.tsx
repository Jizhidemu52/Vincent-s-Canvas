import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { clearAssetFilters, patchAssetFilters, readAssetFilters } from "@/pages/admin/assets/asset-filters";
import { assetMediaUrls, recordMediaLink } from "@/pages/admin/assets/asset-media";
import { RecordMedia } from "@/pages/admin/assets/components/asset-media";

const id = "11111111-1111-4111-8111-111111111111";

describe("admin asset filters", () => {
    test("defaults to images and uses only the established server query fields", () => {
        expect(readAssetFilters(new URLSearchParams()).query).toMatchObject({ kind: "image", sort: "newest" });
        const params = new URLSearchParams({ tab: "projects", assetView: "list", assetOwner: id, assetProject: id, assetQ: " 花型 ", assetTag: "服装", assetSort: "oldest", assetKind: "video" });
        expect(readAssetFilters(params)).toMatchObject({ view: "list", query: { kind: "video", q: "花型", tag: "服装", ownerUserId: id, projectId: id, sort: "oldest" } });
    });
    test("calendar dates are Beijing days with an exclusive next-day boundary", () => {
        const filters = readAssetFilters(new URLSearchParams({ assetFrom: "2026-10-31", assetTo: "2026-11-02" }));
        expect(filters.query.createdFrom).toBe("2026-10-30T16:00:00.000Z");
        expect(filters.query.createdBefore).toBe("2026-11-02T16:00:00.000Z");
        const leap = readAssetFilters(new URLSearchParams({ assetFrom: "2028-02-29", assetTo: "2028-02-29" }));
        expect(leap.query.createdBefore).toBe("2028-02-29T16:00:00.000Z");
    });
    test("invalid or reversed URL filters never reach the API", () => {
        for (const input of [{ assetFrom: "2026-02-30", assetTo: "2026-03-01" }, { assetFrom: "2026-11-03", assetTo: "2026-11-02" }, { assetFrom: "not-a-date", assetTo: "2026-11-02" }]) {
            const query = readAssetFilters(new URLSearchParams(input)).query;
            expect(query.createdFrom).toBeUndefined(); expect(query.createdBefore).toBeUndefined();
        }
        const query = readAssetFilters(new URLSearchParams({ assetOwner: "all", assetProject: "legacy-project", assetSort: "custom", assetQ: "x".repeat(300), assetView: "list", assetKind: "unknown" })).query;
        expect(query.ownerUserId).toBeUndefined(); expect(query.projectId).toBeUndefined(); expect(query.kind).toBeUndefined();
        expect(query.sort).toBe("newest"); expect(query.q).toHaveLength(200);
    });
    test("URL updates and resets preserve tab and unrelated state", () => {
        const original = new URLSearchParams({ tab: "projects", keep: "untouched", assetQ: "old", assetOwner: id });
        const updated = patchAssetFilters(original, { assetQ: "new", assetOwner: undefined });
        expect(updated.get("tab")).toBe("projects"); expect(updated.get("keep")).toBe("untouched"); expect(updated.has("assetOwner")).toBe(false);
        expect(original.get("assetQ")).toBe("old");
        expect(clearAssetFilters(updated).toString()).toBe("tab=projects&keep=untouched");
    });
});

describe("admin media safety", () => {
    test("authenticated thumbnail and original routes remain separate", () => {
        expect(assetMediaUrls(id)).toEqual({ content: `/api/assets/${id}/content`, thumbnail: `/api/assets/${id}/thumb?w=256`, preview: `/api/assets/${id}/thumb?w=1024` });
        expect(assetMediaUrls("../../private")).toBeNull();
        const absolute = `https://canvas.test/api/assets/${id}/content?ignored=1`;
        expect(recordMediaLink(absolute, "https://canvas.test")?.media?.preview).toEndWith("thumb?w=1024");
        expect(recordMediaLink(absolute, "https://other.test")?.media).toBeNull();
    });
    test("remote images are links, never automatically loaded", () => {
        const html = renderToStaticMarkup(<RecordMedia label="结果" urls={[`/api/assets/${id}/content`, "https://external.test/image.png", "https://external.test/movie.mp4"]} />);
        expect(html).toContain(`/api/assets/${id}/thumb?w=256`);
        expect(html).not.toContain('src="https://external.test');
        expect(html).toContain('href="https://external.test/image.png"');
        expect(html).toContain("外部或未知类型文件，仅在点击后打开");
        expect(html).toContain('rel="noopener noreferrer"');
    });
    test("unsafe, credential-bearing, blob and unrelated API addresses are not clickable", () => {
        for (const url of ["javascript:alert(1)", "data:image/png;base64,AA==", "blob:https://canvas.test/old", "//external.test/image.png", "https://name:secret@external.test/image.png", "/api/admin/accounts", "https://external.test\\@local.test/image.png", " https://external.test/image.png"]) {
            expect(recordMediaLink(url, "https://canvas.test")).toBeNull();
        }
        const html = renderToStaticMarkup(<RecordMedia label="原图" urls={["javascript:alert(1)"]} />);
        expect(html).not.toContain("<a "); expect(html).not.toContain("<img");
    });
});

import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { gunzipSync } from "node:zlib";
import { createStandardColorLibraryLoader, deltaE2000, findStandardColors, hexToLab, toStandardColorSelection, type Lab, type Manifest, type StandardColor } from "../src/lib/standard-colors";

const assetDir = resolve(import.meta.dir, "../public/color-library");
const readAsset = (path: string) => readFile(resolve(assetDir, path));
const manifest = JSON.parse(await readAsset("manifest.json").then((bytes) => bytes.toString("utf8"))) as Manifest;

function fixtureFetcher(fail?: (path: string, call: number) => Response | undefined) {
    const calls: string[] = [];
    const fetcher = (async (input: RequestInfo | URL) => {
        const path = new URL(String(input), "http://localhost").pathname.replace(/^\/color-library\//, "");
        calls.push(path);
        const overridden = fail?.(path, calls.filter((item) => item === path).length);
        return overridden || new Response(new Uint8Array(await readAsset(path)));
    }) as typeof fetch;
    return { calls, fetcher };
}

describe("offline standard-color assets", () => {
    test("loads no data until requested and fetches only the selected library chunks", async () => {
        const fixture = fixtureFetcher();
        const loader = createStandardColorLibraryLoader(fixture.fetcher);
        expect(fixture.calls).toEqual([]);
        const loadedManifest = await loader.loadManifest();
        expect(loadedManifest.total).toBe(81583);
        expect(loadedManifest.libraries).toHaveLength(73);
        expect(fixture.calls).toEqual(["manifest.json"]);
        const selected = loadedManifest.libraries.find((item) => item.name === "PANTONE TCX")!;
        const first = loader.loadColors(selected.name);
        const concurrent = loader.loadColors(selected.name);
        expect(first).toBe(concurrent);
        const colors = await first;
        expect(colors).toHaveLength(2801);
        expect(colors.every((color) => color.libraries.includes(selected.name))).toBe(true);
        expect(fixture.calls.slice(1)).toEqual(loadedManifest.chunks.filter((chunk) => selected.chunks.includes(chunk.id)).map((chunk) => chunk.path));
        expect(fixture.calls.length).toBeLessThan(loadedManifest.chunks.length);
        await loader.loadColors(selected.name);
        expect(fixture.calls.length).toBe(selected.chunks.length + 1);
        expect(toStandardColorSelection(colors[0]!, selected.name).datasetVersion).toBe(loadedManifest.version);
    });

    test("decodes every unique color and preserves all 134839 library memberships", async () => {
        const fixture = fixtureFetcher();
        const loader = createStandardColorLibraryLoader(fixture.fetcher);
        const colors = await loader.loadColors();
        expect(colors).toHaveLength(81583);
        expect(new Set(colors.map((color) => color.id)).size).toBe(81583);
        expect(colors.every((color) => /^#[0-9A-F]{6}$/.test(color.hex) && color.source === manifest.source && color.sourceUrl.endsWith(color.id.slice(4)))).toBe(true);
        const memberships = new Map<string, number>();
        colors.forEach((color) => color.libraries.forEach((library) => memberships.set(library, (memberships.get(library) || 0) + 1)));
        expect(Array.from(memberships.values()).reduce((sum, count) => sum + count, 0)).toBe(134839);
        for (const library of manifest.libraries) expect(memberships.get(library.name)).toBe(library.count);
        const requestsAfterAll = fixture.calls.length;
        const jpma = manifest.libraries.find((library) => library.name.startsWith("JPMA"))!;
        expect(await loader.loadColors(jpma.name)).toHaveLength(600);
        expect(fixture.calls.length).toBe(requestsAfterAll);
        const reference = colors.find((color) => color.name === "8042 C")!;
        expect(reference.hex).toBe("#9E7B71");
        expect(findStandardColors(colors, { hex: reference.hex, sort: "nearest", limit: 1 }).items[0]!.deltaE).toBe(0);
    });

    test("keeps the full source audits available outside the initial color payload", async () => {
        const metadata = JSON.parse(gunzipSync(await readAsset(manifest.provenance.metadata.path)).toString("utf8"));
        const conflicts = JSON.parse(gunzipSync(await readAsset(manifest.provenance.conflicts.path)).toString("utf8"));
        expect(metadata.total).toBe(81583);
        expect(metadata.colorMapCoverage).toHaveLength(91);
        expect(conflicts).toHaveLength(3506);
        expect(new Set(conflicts.filter((item: { differences: Record<string, unknown> }) => item.differences.hex).map((item: { id: string }) => item.id)).size).toBe(969);
        expect(manifest.chunks.reduce((sum, chunk) => sum + chunk.bytes, 0)).toBeLessThan(1_000_000);
        expect((await readAsset("manifest.json")).length).toBeLessThan(40_000);
    });

    test("a failed manifest request can retry without resetting the module", async () => {
        const fixture = fixtureFetcher((path, call) => path === "manifest.json" && call === 1 ? new Response("offline", { status: 503 }) : undefined);
        const loader = createStandardColorLibraryLoader(fixture.fetcher);
        await expect(loader.loadManifest()).rejects.toThrow("503");
        await expect(loader.loadManifest()).resolves.toHaveProperty("total", 81583);
        expect(fixture.calls).toEqual(["manifest.json", "manifest.json"]);
    });

    test("a corrupt chunk is rejected and can retry while keeping the cached manifest", async () => {
        const fixture = fixtureFetcher((path, call) => path.endsWith(".gz") && call === 1 ? new Response("truncated gzip") : undefined);
        const loader = createStandardColorLibraryLoader(fixture.fetcher);
        await expect(loader.loadColors("RAL CLASSIC")).rejects.toThrow("完整性校验失败");
        await expect(loader.loadColors("RAL CLASSIC")).resolves.toHaveLength(216);
        expect(fixture.calls.filter((path) => path === "manifest.json")).toHaveLength(1);
        expect(fixture.calls.filter((path) => path.endsWith(".gz"))).toHaveLength(2);
    });

    test("accepts a body already decompressed by fetch under Content-Encoding gzip", async () => {
        const fetcher = (async (input: RequestInfo | URL) => {
            const path = new URL(String(input), "http://localhost").pathname.replace(/^\/color-library\//, "");
            const file = await readAsset(path);
            return path.endsWith(".gz") ? new Response(new Uint8Array(gunzipSync(file)), { headers: { "Content-Encoding": "gzip", "Content-Type": "application/json" } }) : new Response(new Uint8Array(file));
        }) as typeof fetch;
        const colors = await createStandardColorLibraryLoader(fetcher).loadColors("RAL CLASSIC");
        expect(colors).toHaveLength(216);
        expect(colors.find((color) => color.name === "1000")!.hex).toBe("#CDBA88");
    });

    test("rejects modified JSON even if the server has already decompressed gzip", async () => {
        const fetcher = (async (input: RequestInfo | URL) => {
            const path = new URL(String(input), "http://localhost").pathname.replace(/^\/color-library\//, "");
            const file = await readAsset(path);
            if (!path.endsWith(".gz")) return new Response(new Uint8Array(file));
            const tuples = JSON.parse(gunzipSync(file).toString("utf8"));
            tuples[0][2] = "FFFFFF";
            return new Response(JSON.stringify(tuples), { headers: { "Content-Encoding": "gzip" } });
        }) as typeof fetch;
        await expect(createStandardColorLibraryLoader(fetcher).loadColors("RAL CLASSIC")).rejects.toThrow("完整性校验失败");
    });

    test("unknown libraries do not silently load the entire dataset", async () => {
        const fixture = fixtureFetcher();
        await expect(createStandardColorLibraryLoader(fixture.fetcher).loadColors("missing-library")).rejects.toThrow("未找到色库");
        expect(fixture.calls).toEqual(["manifest.json"]);
    });
});

const color = (id: string, name: string, hex: string, extra: Partial<StandardColor> = {}): StandardColor => ({ id, name, hex, brand: "PANTONE TCX", libraries: ["PANTONE TCX"], sourceUrl: `https://example.test/${id}`, source: "fixture", ...extra });

describe("catalog search and selection provenance", () => {
    const colors = [color("a", "11-0605TCX", "#EDE6DE", { alias: "Jet Stream" }), color("b", "1000", "#CDBA88", { brand: "RAL CLASSIC", libraries: ["RAL CLASSIC"], alias: "绿米色" }), color("c", "11-0000TCX", "#FFFFFF", { libraries: ["PANTONE TCX", "公开组合"], alias: "纯白色" })];

    test.each(["11-0605", "110605", "PANTONE 11-0605 tcx", "Jet Stream", "#ede6de"])("matches code, name, library and HEX query %s", (query) => {
        expect(findStandardColors(colors, { query }).items.map((item) => item.color.id)).toEqual(["a"]);
    });

    test("searches alternate memberships and Chinese aliases", () => {
        expect(findStandardColors(colors, { query: "公开组合" }).items[0]!.color.id).toBe("c");
        expect(findStandardColors(colors, { query: "绿米色" }).items[0]!.color.id).toBe("b");
    });

    test("filters before pagination and keeps catalog order without mutating the input", () => {
        expect(findStandardColors(colors, { query: "TCX", limit: 1, offset: 1 })).toEqual({ items: [{ color: colors[2] }], total: 2 });
        expect(findStandardColors(colors, { limit: 0 }).items).toEqual([]);
        expect(findStandardColors(colors, { offset: -2, limit: 1 }).items[0]!.color.id).toBe("a");
        expect(colors.map((item) => item.id)).toEqual(["a", "b", "c"]);
    });

    test("nearest sorting returns exact matches first with stable ties", () => {
        const items = [colors[1]!, colors[0]!, { ...colors[0]!, id: "same-value" }, colors[2]!];
        const nearest = findStandardColors(items, { hex: "#EDE6DE", sort: "nearest", limit: 3 });
        expect(nearest.items.slice(0, 2).map((item) => item.color.id)).toEqual(["a", "same-value"]);
        expect(nearest.items[0]!.deltaE).toBe(0);
        expect(nearest.items[2]!.deltaE).toBeGreaterThan(0);
        expect(findStandardColors(items, { hex: "#EDE6DE", sort: "nearest", limit: 1, offset: 1 }).items[0]!.color.id).toBe("same-value");
        expect(() => findStandardColors(items, { sort: "nearest" })).toThrow("目标颜色");
        expect(() => findStandardColors(items, { hex: "not-a-color" })).toThrow("HEX");
    });

    test("persists an allowed membership and an explicit dataset version", () => {
        expect(toStandardColorSelection(colors[2]!, "公开组合", manifest.version)).toEqual({ id: "c", name: "11-0000TCX", hex: "#FFFFFF", library: "公开组合", sourceUrl: "https://example.test/c", source: "fixture", datasetVersion: manifest.version });
        expect(() => toStandardColorSelection(colors[2]!, "RAL CLASSIC", manifest.version)).toThrow("不属于");
        expect(() => toStandardColorSelection(colors[2]!)).toThrow("版本");
    });
});

describe("CIE color difference", () => {
    test("converts sRGB black, white and red to D65 Lab", () => {
        expect(hexToLab("#000")).toEqual([0, 0, 0]);
        const white = hexToLab("FFFFFF");
        white.forEach((value, index) => expect(value).toBeCloseTo([100, 0, 0][index]!, 4));
        const red = hexToLab("#FF0000");
        red.forEach((value, index) => expect(value).toBeCloseTo([53.2408, 80.0925, 67.2032][index]!, 3));
    });

    // Sharma, Wu & Dalal's supplementary CIEDE2000 test data, including hue-wrap
    // and zero-chroma cases: https://hajim.rochester.edu/ece/sites/gsharma/ciede2000/
    const pairs: Array<[Lab, Lab, number]> = [
        [[50, 2.6772, -79.7751], [50, 0, -82.7485], 2.0425],
        [[50, 3.1571, -77.2803], [50, 0, -82.7485], 2.8615],
        [[50, 2.8361, -74.0200], [50, 0, -82.7485], 3.4412],
        [[50, -1.3802, -84.2814], [50, 0, -82.7485], 1.0000],
        [[50, -1.1848, -84.8006], [50, 0, -82.7485], 1.0000],
        [[50, -0.9009, -85.5211], [50, 0, -82.7485], 1.0000],
        [[50, 0, 0], [50, -1, 2], 2.3669],
        [[50, -1, 2], [50, 0, 0], 2.3669],
        [[50, 2.4900, -0.0010], [50, -2.4900, 0.0009], 7.1792],
        [[50, 2.4900, -0.0010], [50, -2.4900, 0.0010], 7.1792],
        [[50, 2.4900, -0.0010], [50, -2.4900, 0.0011], 7.2195],
        [[50, 2.4900, -0.0010], [50, -2.4900, 0.0012], 7.2195],
        [[50, -0.0010, 2.4900], [50, 0.0009, -2.4900], 4.8045],
        [[50, -0.0010, 2.4900], [50, 0.0010, -2.4900], 4.8045],
        [[50, -0.0010, 2.4900], [50, 0.0011, -2.4900], 4.7461],
        [[50, 2.5, 0], [50, 0, -2.5], 4.3065],
        [[50, 2.5, 0], [73, 25, -18], 27.1492],
        [[50, 2.5, 0], [61, -5, 29], 22.8977],
        [[50, 2.5, 0], [56, -27, -3], 31.9030],
        [[50, 2.5, 0], [58, 24, 15], 19.4535],
        [[50, 2.5, 0], [50, 3.1736, 0.5854], 1.0000],
        [[50, 2.5, 0], [50, 3.2972, 0], 1.0000],
        [[50, 2.5, 0], [50, 1.8634, 0.5757], 1.0000],
        [[50, 2.5, 0], [50, 3.2592, 0.3350], 1.0000],
        [[60.2574, -34.0099, 36.2677], [60.4626, -34.1751, 39.4387], 1.2644],
        [[63.0109, -31.0961, -5.8663], [62.8187, -29.7946, -4.0864], 1.2630],
        [[61.2901, 3.7196, -5.3901], [61.4292, 2.2480, -4.9620], 1.8731],
        [[35.0831, -44.1164, 3.7933], [35.0232, -40.0716, 1.5901], 1.8645],
        [[22.7233, 20.0904, -46.6940], [23.0331, 14.9730, -42.5619], 2.0373],
        [[36.4612, 47.8580, 18.3852], [36.2715, 50.5065, 21.2231], 1.4146],
        [[90.8027, -2.0831, 1.4410], [91.1528, -1.6435, 0.0447], 1.4441],
        [[90.9257, -0.5406, -0.9208], [88.6381, -0.8985, -0.7239], 1.5381],
        [[6.7747, -0.2908, -2.4247], [5.8714, -0.0985, -2.2286], 0.6377],
        [[2.0776, 0.0795, -1.1350], [0.9033, -0.0636, -0.5514], 0.9082],
    ];
    test.each(pairs)("matches CIEDE2000 reference pair %j / %j", (first, second, expected) => {
        expect(Math.abs(deltaE2000(first, second) - expected)).toBeLessThan(0.00005);
        expect(deltaE2000(second, first)).toBeCloseTo(deltaE2000(first, second), 10);
        expect(deltaE2000(first, first)).toBe(0);
    });
});

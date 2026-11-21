export type StandardColor = {
    id: string;
    name: string;
    hex: string;
    brand: string;
    libraries: string[];
    sourceUrl: string;
    source: string;
    alias?: string;
};

export type StandardColorSelection = {
    id: string;
    name: string;
    hex: string;
    library: string;
    sourceUrl: string;
    source: string;
    datasetVersion: string;
};

type ColorChunk = { id: string; path: string; count: number; bytes: number; rawBytes: number; sha256: string; rawSha256: string };
type ProvenanceFile = { path: string; bytes: number; sha256: string; sourceSha256: string };
export type Manifest = {
    schemaVersion: 1;
    version: string;
    format: "tuple-gzip-v1";
    total: number;
    membershipTotal: number;
    source: string;
    sourceUrlPrefix: string;
    sourceSha256: string;
    fetchedAt: string;
    libraries: Array<{ name: string; count: number; chunks: string[] }>;
    chunks: ColorChunk[];
    provenance: { metadata: ProvenanceFile; conflicts: ProvenanceFile };
    coverage: {
        standardLibraryCount: number;
        publicColorMapGroupCount: number;
        publicColorMapStatusCounts: Record<string, number>;
        allWebsiteColorsComplete: boolean;
        scope: string;
        hexConflictUniqueColorCount: number;
        mergePolicy: string;
        notes: string[];
    };
};
export type StandardColorManifest = Manifest;

const assetRoot = `${import.meta.env?.BASE_URL ?? "/"}color-library/`;
const versions = new WeakMap<StandardColor, string>();

function validateManifest(value: Manifest): Manifest {
    if (value?.schemaVersion !== 1 || value.format !== "tuple-gzip-v1" || !value.version || !Array.isArray(value.libraries) || !Array.isArray(value.chunks)) {
        throw new Error("色库目录格式不正确，请刷新后重试");
    }
    const chunkIds = new Set(value.chunks.map((chunk) => chunk.id));
    const validChunks = value.chunks.every((chunk) => Number.isSafeInteger(chunk.count) && chunk.count > 0 && /^chunks\/colors-\d{3}-[a-f0-9]{12}\.json\.gz$/.test(chunk.path) && /^[a-f0-9]{64}$/.test(chunk.sha256) && /^[a-f0-9]{64}$/.test(chunk.rawSha256));
    const validLibraries = value.libraries.every((library) => typeof library.name === "string" && library.name.length > 0 && Number.isSafeInteger(library.count) && library.count > 0 && Array.isArray(library.chunks) && library.chunks.length > 0 && library.chunks.every((id) => chunkIds.has(id)) && new Set(library.chunks).size === library.chunks.length);
    if (!validChunks || !validLibraries || chunkIds.size !== value.chunks.length || new Set(value.libraries.map((library) => library.name)).size !== value.libraries.length || value.chunks.reduce((sum, chunk) => sum + chunk.count, 0) !== value.total || typeof value.source !== "string" || typeof value.sourceUrlPrefix !== "string") {
        throw new Error("色库目录校验失败，请刷新后重试");
    }
    return value;
}

/** No fetch happens at import time; failed requests are evicted so Retry works. */
export function createStandardColorLibraryLoader(fetcher: typeof fetch = (...args) => fetch(...args), root = assetRoot) {
    let manifestRequest: Promise<Manifest> | undefined;
    const chunkRequests = new Map<string, Promise<StandardColor[]>>();
    const libraryRequests = new Map<string, Promise<StandardColor[]>>();

    function loadManifest(): Promise<Manifest> {
        if (!manifestRequest) {
            manifestRequest = fetcher(`${root}manifest.json`).then(async (response) => {
                if (!response.ok) throw new Error(`色库目录加载失败（${response.status}），请重试`);
                return validateManifest(await response.json() as Manifest);
            }).catch((error: unknown) => { manifestRequest = undefined; throw error; });
        }
        return manifestRequest;
    }

    function loadChunk(chunk: ColorChunk, manifest: Manifest): Promise<StandardColor[]> {
        const key = `${manifest.version}:${chunk.id}`;
        const cached = chunkRequests.get(key);
        if (cached) return cached;
        const request = (async () => {
            const response = await fetcher(root + chunk.path);
            if (!response.ok) throw new Error(`色库数据加载失败（${response.status}），请重试`);
            const bytes = new Uint8Array(await response.arrayBuffer());
            const [{ gunzipSync, strFromU8 }, { sha256 }, { bytesToHex }] = await Promise.all([import("fflate"), import("@noble/hashes/sha256"), import("@noble/hashes/utils")]);
            // Vite and some static servers set Content-Encoding:gzip for .gz;
            // fetch then returns the already decoded body. Validate both forms.
            const isGzip = bytes[0] === 0x1f && bytes[1] === 0x8b;
            if (isGzip && bytesToHex(sha256(bytes)) !== chunk.sha256) throw new Error("色库文件完整性校验失败，请刷新后重试");
            const raw = isGzip ? gunzipSync(bytes) : bytes;
            if (bytesToHex(sha256(raw)) !== chunk.rawSha256) throw new Error("色库文件完整性校验失败，请刷新后重试");
            const tuples: unknown = JSON.parse(strFromU8(raw));
            if (!Array.isArray(tuples) || tuples.length !== chunk.count) throw new Error("色库分块条数不一致，请重试");
            const ids = new Set<number>();
            return tuples.map((tuple: unknown): StandardColor => {
                if (!Array.isArray(tuple) || tuple.length !== 6) throw new Error("色库颜色记录格式错误");
                const [id, name, hex, brand, members, alias] = tuple as [number, string, string, number, number[], string];
                const isLibraryIndex = (index: number) => Number.isSafeInteger(index) && index >= 0 && index < manifest.libraries.length;
                if (!Number.isSafeInteger(id) || id <= 0 || ids.has(id) || typeof name !== "string" || !name || typeof hex !== "string" || !/^[0-9A-F]{6}$/.test(hex) || !isLibraryIndex(brand) || !Array.isArray(members) || !members.length || !members.every(isLibraryIndex) || new Set(members).size !== members.length || !members.includes(brand) || typeof alias !== "string") {
                    throw new Error("色库颜色记录校验失败");
                }
                ids.add(id);
                const color: StandardColor = { id: `qtc-${id}`, name, hex: `#${hex}`, brand: manifest.libraries[brand].name, libraries: members.map((index) => manifest.libraries[index].name), sourceUrl: manifest.sourceUrlPrefix + id, source: manifest.source, alias };
                versions.set(color, manifest.version);
                return color;
            });
        })().catch((error: unknown) => { chunkRequests.delete(key); throw error; });
        chunkRequests.set(key, request);
        return request;
    }

    function loadColors(library = ""): Promise<StandardColor[]> {
        const cached = libraryRequests.get(library);
        if (cached) return cached;
        const request = (async () => {
            const manifest = await loadManifest();
            const selected = library ? manifest.libraries.find((item) => item.name === library) : undefined;
            if (library && !selected) throw new Error(`未找到色库：${library}`);
            const selectedChunks = selected ? new Set(selected.chunks) : undefined;
            const chunks = selectedChunks ? manifest.chunks.filter((chunk) => selectedChunks.has(chunk.id)) : manifest.chunks;
            const loaded = (await Promise.all(chunks.map((chunk) => loadChunk(chunk, manifest)))).flat();
            const colors = library ? loaded.filter((color) => color.libraries.includes(library)) : loaded;
            const expected = selected?.count ?? manifest.total;
            if (colors.length !== expected || new Set(colors.map((color) => color.id)).size !== expected) throw new Error("色库总数校验失败，请刷新后重试");
            return colors;
        })().catch((error: unknown) => { libraryRequests.delete(library); throw error; });
        libraryRequests.set(library, request);
        return request;
    }

    return { loadManifest, loadColors };
}

const loader = createStandardColorLibraryLoader();
export const loadStandardColorManifest = loader.loadManifest;
export const loadStandardColors = loader.loadColors;

import {deltaE2000,hexToLab,type Lab} from "../../../shared/color-distance";
export {deltaE2000,hexToLab,type Lab};

const searchIndex = new WeakMap<StandardColor, { text: string; lab?: Lab }>();
const normalizeQuery = (text: string) => text.normalize("NFKC").toLowerCase().replace(/[\s#_-]+/g, "");

export function findStandardColors(colors: readonly StandardColor[], { query = "", hex, sort = "catalog", limit = 60, offset = 0 }: { query?: string; hex?: string; sort?: "catalog" | "nearest"; limit?: number; offset?: number } = {}): { items: Array<{ color: StandardColor; deltaE?: number }>; total: number } {
    if (sort === "nearest" && !hex) throw new Error("请选择用于比较的目标颜色");
    const targetLab = hex ? hexToLab(hex) : undefined;
    const terms = query.trim().split(/\s+/).map(normalizeQuery).filter(Boolean);
    const matched: Array<{ color: StandardColor; deltaE?: number; index: number }> = [];
    colors.forEach((color, index) => {
        let cached = searchIndex.get(color);
        if (!cached) {
            cached = { text: normalizeQuery([color.name, color.alias, color.hex, color.brand, ...color.libraries].join(" ")) };
            searchIndex.set(color, cached);
        }
        if (!terms.every((term) => cached.text.includes(term))) return;
        let deltaE: number | undefined;
        if (targetLab) {
            cached.lab ??= hexToLab(color.hex);
            deltaE = deltaE2000(targetLab, cached.lab);
        }
        matched.push({ color, deltaE, index });
    });
    if (sort === "nearest") matched.sort((a, b) => a.deltaE! - b.deltaE! || a.index - b.index);
    const start = Number.isFinite(offset) ? Math.max(0, Math.floor(offset)) : 0;
    const size = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : 60;
    return { items: matched.slice(start, start + size).map(({ color, deltaE }) => deltaE === undefined ? { color } : { color, deltaE }), total: matched.length };
}

export function toStandardColorSelection(color: StandardColor, library?: string, version?: string): StandardColorSelection {
    const selectedLibrary = library || color.brand;
    if (!color.libraries.includes(selectedLibrary)) throw new Error("该颜色不属于所选色库");
    const datasetVersion = version || versions.get(color);
    if (!datasetVersion) throw new Error("缺少色库版本，请重新加载色库后选择颜色");
    return { id: color.id, name: color.name, hex: color.hex, library: selectedLibrary, sourceUrl: color.sourceUrl, source: color.source, datasetVersion };
}

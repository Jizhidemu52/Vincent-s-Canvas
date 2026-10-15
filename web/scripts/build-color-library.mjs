/**
 * Rebuild the offline color assets from the verified, external source snapshot:
 * node web/scripts/build-color-library.mjs --source <色库数据.json>
 *   --meta <real-library-sources.json> --conflicts <色库数据冲突记录.json>
 * No network requests. Source paths are deliberately not tied to one workstation.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const requireCondition = (condition, message) => { if (!condition) throw new Error(message); };

export async function buildColorLibrary({ source, meta, conflicts, out = resolve(scriptDir, "../public/color-library") }) {
    const [sourceBytes, metaBytes, conflictBytes] = await Promise.all([source, meta, conflicts].map((path) => readFile(path)));
    const colors = JSON.parse(sourceBytes.toString("utf8"));
    const sourceMeta = JSON.parse(metaBytes.toString("utf8"));
    const sourceConflicts = JSON.parse(conflictBytes.toString("utf8"));
    requireCondition(Array.isArray(colors) && colors.length === sourceMeta.total, "Source row count does not match its audit metadata");
    requireCondition(Array.isArray(sourceConflicts) && sourceConflicts.length === sourceMeta.conflictCount, "Conflict audit count does not match metadata");
    const names = sourceMeta.libraries.map((library) => library.name);
    const indices = new Map(names.map((name, index) => [name, index]));
    requireCondition(indices.size === names.length, "Duplicate library names");
    const sourceName = "千通彩公开页面";
    const sourceUrlPrefix = "https://www.qtccolor.com/secaiku/color/";
    const buckets = names.map(() => []);
    const memberCounts = names.map(() => 0);
    const ids = new Set();
    for (const color of colors) {
        const id = Number(color.id?.replace(/^qtc-/, ""));
        requireCondition(Number.isSafeInteger(id) && id > 0 && color.id === `qtc-${id}` && color.sourceId === id, `Invalid ID: ${color.id}`);
        requireCondition(!ids.has(id), `Duplicate ID: ${color.id}`);
        ids.add(id);
        requireCondition(typeof color.name === "string" && color.name.length > 0 && /^#[0-9A-F]{6}$/.test(color.hex), `Invalid color: ${color.id}`);
        requireCondition(color.source === sourceName && color.sourceUrl === sourceUrlPrefix + id, `Unexpected provenance: ${color.id}`);
        const brand = indices.get(color.brand);
        const members = color.libraries.map((name) => indices.get(name));
        requireCondition(brand !== undefined && members.length > 0 && members.every((index) => index !== undefined) && new Set(members).size === members.length && members.includes(brand), `Invalid memberships: ${color.id}`);
        members.forEach((index) => memberCounts[index]++);
        buckets[brand].push([id, color.name, color.hex.slice(1), brand, members, color.alias || ""]);
    }
    names.forEach((name, index) => requireCondition(memberCounts[index] === sourceMeta.libraries[index].count, `Membership mismatch: ${name}`));
    const version = `qtccolor-${sha256(sourceBytes).slice(0, 16)}`;
    await mkdir(resolve(out, "chunks"), { recursive: true });
    await mkdir(resolve(out, "provenance"), { recursive: true });
    const chunks = [];
    const libraries = names.map((name, index) => ({ name, count: memberCounts[index], chunks: [] }));
    for (const bucket of buckets) {
        for (let offset = 0; offset < bucket.length; offset += 2048) {
            const rows = bucket.slice(offset, offset + 2048);
            const raw = Buffer.from(JSON.stringify(rows));
            const compressed = gzipSync(raw, { level: 9 });
            const digest = sha256(compressed);
            const id = `colors-${String(chunks.length).padStart(3, "0")}-${digest.slice(0, 12)}`;
            const path = `chunks/${id}.json.gz`;
            await writeFile(resolve(out, path), compressed);
            chunks.push({ id, path, count: rows.length, bytes: compressed.length, rawBytes: raw.length, sha256: digest, rawSha256: sha256(raw) });
            const members = new Set(rows.flatMap((row) => row[4]));
            members.forEach((index) => libraries[index].chunks.push(id));
        }
    }
    const provenance = {};
    for (const [key, raw] of [["metadata", metaBytes], ["conflicts", conflictBytes]]) {
        const compressed = gzipSync(raw, { level: 9 });
        const path = `provenance/${key}-${sha256(raw).slice(0, 12)}.json.gz`;
        await writeFile(resolve(out, path), compressed);
        provenance[key] = { path, bytes: compressed.length, sha256: sha256(compressed), sourceSha256: sha256(raw) };
    }
    const manifest = {
        schemaVersion: 1,
        version,
        format: "tuple-gzip-v1",
        total: colors.length,
        membershipTotal: memberCounts.reduce((sum, count) => sum + count, 0),
        source: sourceName,
        sourceUrlPrefix,
        sourceSha256: sha256(sourceBytes),
        fetchedAt: sourceMeta.fetchedAt,
        libraries,
        chunks,
        provenance,
        coverage: {
            standardLibraryCount: sourceMeta.standardLibraryCount,
            publicColorMapGroupCount: sourceMeta.publicColorMapGroupCount,
            publicColorMapStatusCounts: sourceMeta.publicColorMapStatusCounts,
            allWebsiteColorsComplete: sourceMeta.allWebsiteColorsComplete,
            scope: sourceMeta.coverageScope,
            hexConflictUniqueColorCount: sourceMeta.hexConflictUniqueColorCount,
            mergePolicy: sourceMeta.mergePolicy,
            notes: sourceMeta.notes,
        },
    };
    await writeFile(resolve(out, "manifest.json"), JSON.stringify(manifest));
    return { version, total: colors.length, libraries: libraries.length, chunks: chunks.length, manifestBytes: Buffer.byteLength(JSON.stringify(manifest)), colorBytes: chunks.reduce((sum, chunk) => sum + chunk.bytes, 0), provenanceBytes: Object.values(provenance).reduce((sum, file) => sum + file.bytes, 0) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const args = Object.fromEntries(Array.from({ length: Math.floor((process.argv.length - 2) / 2) }, (_, index) => [process.argv[2 + index * 2].replace(/^--/, ""), process.argv[3 + index * 2]]));
    for (const key of ["source", "meta", "conflicts"]) requireCondition(args[key], `Missing --${key}`);
    console.log(JSON.stringify(await buildColorLibrary(args)));
}

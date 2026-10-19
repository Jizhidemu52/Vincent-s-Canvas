import { describe, expect, test } from "bun:test";
import { encodeCursor, makeCursorPage, parseCursorPage } from "../src/cursor-pagination";
import { demoTaskSummary, pageDemoRecords, parseDemoTaskFilters } from "../src/demo-list-pagination";

describe("cursor pagination boundaries", () => {
  test("defaults to 60, caps at 200 and rejects invalid cursors without coercing timestamps", () => {
    expect(parseCursorPage({})).toEqual({ limit: 60, cursor: null });
    expect(parseCursorPage({ limit: "200" }).limit).toBe(200);
    for (const limit of [0, 201, 1.2, "bad", []]) expect(() => parseCursorPage({ limit })).toThrow();
    for (const cursor of ["broken", "###", Buffer.from("null").toString("base64url"), encodeCursor({ createdAt: "not-time", id: "1" })]) expect(() => parseCursorPage({ cursor })).toThrow();
    const point = { createdAt: "2026-10-19T01:02:03.123456Z", id: "00000000-0000-4000-8000-000000000001" };
    expect(parseCursorPage({ cursor: encodeCursor(point) }).cursor).toEqual(point);
  });

  test("uses one lookahead row and preserves microseconds in nextCursor", () => {
    const rows = ["123456", "123455", "123454"].map((fraction, index) => ({ id: String(index), createdAt: `2026-10-19T01:02:03.${fraction}Z` }));
    const page = makeCursorPage(rows, 2, row => row);
    expect(page.items).toEqual(rows.slice(0, 2));
    expect(page.hasMore).toBe(true);
    expect(parseCursorPage({ cursor: page.nextCursor }).cursor).toEqual(rows[1]);
    expect(makeCursorPage(rows.slice(0, 2), 2, row => row).nextCursor).toBeNull();
  });

  test("demo keyset handles ties, insertion, complete traversal and light summaries", () => {
    const rows = Array.from({ length: 137 }, (_, i) => ({ id: String(i).padStart(3, "0"), createdAt: "2026-10-19T00:00:00.123Z", prompt: "x".repeat(1000), parameters: { image: "large" }, sourceUrls: ["source"], resultUrls: ["result"] }));
    const first = pageDemoRecords(rows, {});
    expect(first.items).toHaveLength(60);
    const second = pageDemoRecords([...rows, { ...rows[0], id: "999" }], { cursor: first.nextCursor });
    const third = pageDemoRecords(rows, { cursor: second.nextCursor });
    const ids = [...first.items, ...second.items, ...third.items].map(row => row.id);
    expect(ids).toHaveLength(137);
    expect(new Set(ids).size).toBe(137);
    expect(third.hasMore).toBe(false);
    const summary = demoTaskSummary(first.items[0]);
    expect(summary.prompt).toHaveLength(240);
    expect(summary).not.toHaveProperty("parameters");
    expect(summary).not.toHaveProperty("sourceUrls");
    expect(summary.resultUrls).toEqual(["result"]);
  });

  test("exact task lookups permit 200 UUIDs, never an unbounded caller-supplied list", () => {
    const ids = Array.from({ length: 200 }, () => crypto.randomUUID());
    expect(parseDemoTaskFilters({ ids: ids.join(",") }).ids).toEqual(ids);
    expect(() => parseDemoTaskFilters({ ids: [...ids, crypto.randomUUID()].join(",") })).toThrow();
    expect(() => parseDemoTaskFilters({ ids: "invalid" })).toThrow();
  });
});

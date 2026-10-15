import { expect, test } from "bun:test";
import { createWorkbenchProjectStorage } from "../src/pages/design-workbench/local/project-storage";
import { sanitizeProject } from "../src/pages/design-workbench/local/repeat/main.js";

function memory() {
    const values = new Map<string, unknown>();
    return {
        values,
        async getItem<T>(key: string) {
            return structuredClone(values.get(key) ?? null) as T | null;
        },
        async setItem<T>(key: string, value: T) {
            values.set(key, structuredClone(value));
            return value;
        },
    };
}

test("local workbenches isolate employee projects and trial projects", async () => {
    const storage = memory();
    const a = createWorkbenchProjectStorage(
        storage,
        "a",
        () => "a",
        () => true,
    );
    await a.saveProject("placement", { image: "data:image/png;base64,AAAA", layers: [1] });
    expect(
        await createWorkbenchProjectStorage(
            storage,
            "b",
            () => "b",
            () => true,
        ).loadProject("placement"),
    ).toBeNull();
    expect(
        await createWorkbenchProjectStorage(
            storage,
            null,
            () => null,
            () => true,
        ).loadProject("placement"),
    ).toBeNull();
    expect(await a.loadProject("placement")).toEqual({ image: "data:image/png;base64,AAAA", layers: [1] });
});

test("identity change or unmount rejects pending reads and further writes", async () => {
    const storage = memory();
    let owner: string | null = "a",
        active = true;
    const a = createWorkbenchProjectStorage(
        {
            ...storage,
            async getItem<T>(key: string) {
                const saved = await storage.getItem<T>(key);
                owner = "b";
                return saved;
            },
        },
        "a",
        () => owner,
        () => active,
    );
    await a.saveProject("repeat", { mode: "half" });
    await expect(a.loadProject("repeat")).rejects.toThrow("身份已变化");
    await expect(a.saveProject("repeat", { mode: "mirror" })).rejects.toThrow("身份已变化");
    owner = "a";
    active = false;
    await expect(a.saveProject("repeat", {})).rejects.toThrow("身份已变化");
    expect(storage.values.size).toBe(1);
    expect(storage.values.get("owner:a:repeat")).toEqual({ mode: "half" });
});

test("in-flight saves retain the original immutable owner partition and snapshot", async () => {
    const storage = memory();
    let owner = "a";
    const project = { elements: [{ x: 0.1 }] };
    const a = createWorkbenchProjectStorage(
        {
            ...storage,
            async setItem<T>(key: string, value: T) {
                owner = "b";
                project.elements[0].x = 0.9;
                return storage.setItem(key, value);
            },
        },
        "a",
        () => owner,
        () => true,
    );
    await expect(a.saveProject("repeat", project)).rejects.toThrow("身份已变化");
    expect(storage.values.get("owner:a:repeat")).toEqual({ elements: [{ x: 0.1 }] });
    expect(storage.values.has("owner:b:repeat")).toBe(false);
});

test("repeat imports reject remote sources, SVG data, markup and oversized dimensions", () => {
    const fixture = { version: 1, widthCm: 10, heightCm: 10, dpi: 150, mode: "half", background: "#ffffff", transparent: false, elements: [{ src: "/design-workbench/assets/flower.svg", x: 0.2, y: 0.3, size: 0.4, angle: 30 }] };
    expect(sanitizeProject(fixture).elements).toHaveLength(1);
    for (const src of ["https://example.com/a.png", "data:image/svg+xml;base64,AAAA", 'data:image/png;base64,AAAA" onerror=alert(1)']) {
        expect(() => sanitizeProject({ ...fixture, elements: [{ ...fixture.elements[0], src }] })).toThrow();
    }
    expect(() => sanitizeProject({ ...fixture, widthCm: 61 })).toThrow();
    expect(() => sanitizeProject({ ...fixture, elements: [null] })).toThrow();
});

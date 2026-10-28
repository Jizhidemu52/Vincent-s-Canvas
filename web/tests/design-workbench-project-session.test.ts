import { expect, test } from "bun:test";
import { createProjectSession, sameProject } from "../src/pages/design-workbench/local/project-session.js";
import { validate, version } from "uuid";

function fixture(values = new Map<string, any>()) {
    let state = { width: 10, src: "data:image/png;base64,AAAA" };
    let dirty = false;
    let fail = false;
    let pause: Promise<void> | null = null;
    const session = createProjectSession({
        key: "tool",
        delay: 5,
        services: {
            loadProject: async (key: string) => structuredClone(values.get(key) ?? null),
            saveProject: async (key: string, value: any) => {
                const copy = structuredClone(value);
                if (pause) await pause;
                if (fail) throw new Error("存储已满");
                values.set(key, copy);
            },
            setDirty: (value: boolean) => {
                dirty = value;
            },
        },
        snapshot: () => structuredClone(state),
        fresh: async () => ({ width: 10, src: "new" }),
        apply: async (value: any) => {
            state = value;
        },
    });
    return {
        session,
        values,
        edit(width: number) {
            state.width = width;
            session.changed();
        },
        current: () => state,
        dirty: () => dirty,
        fail(value: boolean) {
            fail = value;
        },
        pause(value: Promise<void> | null) {
            pause = value;
        },
    };
}

test("HTTP origins create and restore workbench projects without the secure-context UUID API", async () => {
    const native = Object.getOwnPropertyDescriptor(globalThis, "crypto");
    const secureRandom = crypto.getRandomValues.bind(crypto);
    Object.defineProperty(globalThis, "crypto", { configurable: true, value: { getRandomValues: secureRandom } });
    const f = fixture();
    try {
        await f.session.initialize();
        await f.session.create("图片_v2 工程");
        const id = f.session.view().activeId!;
        expect(validate(id)).toBe(true);
        expect(version(id)).toBe(4);
        const next = fixture(f.values);
        await next.session.initialize();
        expect(next.session.view().activeId).toBe(id);
        next.session.dispose();
    } finally {
        f.session.dispose();
        if (native) Object.defineProperty(globalThis, "crypto", native);
    }
});

test("first edit is dirty before autosave, and persisted data survives reopening", async () => {
    const f = fixture();
    await f.session.initialize();
    f.edit(20);
    expect(f.dirty()).toBe(true);
    await Bun.sleep(30);
    expect(f.dirty()).toBe(false);
    expect(f.session.view().projects).toHaveLength(1);
    const next = fixture(f.values);
    await next.session.initialize();
    expect(next.current().width).toBe(20);
    f.session.dispose();
    next.session.dispose();
});

test("original single project remains selectable after creating and renaming another project", async () => {
    const f = fixture(new Map([["tool", { width: 42, src: "original" }]]));
    await f.session.initialize();
    expect(f.current().width).toBe(42);
    expect(f.session.view().activeId).toBe("legacy");
    await f.session.create("第二个工程");
    f.edit(55);
    await f.session.save();
    const second = f.session.view().activeId;
    await f.session.rename("重命名工程");
    await f.session.open("legacy");
    expect(f.current().width).toBe(42);
    await f.session.open(second!);
    expect(f.current().width).toBe(55);
    expect(f.values.get("tool")).toEqual({ width: 42, src: "original" });
    expect(f.session.view().projects.map((p) => p.name)).toEqual(["原有本地工程", "重命名工程"]);
    f.session.dispose();
});

test("failed saves remain dirty and prevent switching away", async () => {
    const f = fixture(new Map([["tool", { width: 42, src: "original" }]]));
    await f.session.initialize();
    f.fail(true);
    f.edit(99);
    await expect(f.session.create("不能切换")).rejects.toThrow("存储已满");
    expect(f.current().width).toBe(99);
    expect(f.dirty()).toBe(true);
    expect(f.session.view().error).toBe("存储已满");
    f.fail(false);
    await f.session.save();
    expect(f.dirty()).toBe(false);
    f.session.dispose();
});

test("editing during a slow write does not incorrectly mark the newer revision saved", async () => {
    const f = fixture();
    await f.session.initialize();
    let resume!: () => void;
    f.pause(
        new Promise<void>((resolve) => {
            resume = resolve;
        }),
    );
    f.edit(20);
    const writing = f.session.save();
    f.edit(30);
    resume();
    await writing;
    expect(f.dirty()).toBe(true);
    await f.session.save();
    expect(f.dirty()).toBe(false);
    const id = f.session.view().activeId;
    expect(f.values.get(`tool:project:${id}`).width).toBe(30);
    f.session.dispose();
});

test("history comparison never serializes multi-megabyte image data", () => {
    const src = "data:image/png;base64," + "A".repeat(4_000_000);
    const original = JSON.stringify;
    JSON.stringify = () => {
        throw new Error("must not stringify");
    };
    try {
        expect(sameProject({ src, layers: [{ x: 1 }] }, { src, layers: [{ x: 1 }] })).toBe(true);
        expect(sameProject({ src, layers: [{ x: 1 }] }, { src, layers: [{ x: 2 }] })).toBe(false);
    } finally {
        JSON.stringify = original;
    }
});

test("JSON imports create a separate editable project without replacing the current save", async () => {
    const f = fixture(new Map([["tool", { width: 42, src: "original" }]]));
    await f.session.initialize();
    await f.session.create("导入工程", { width: 88, src: "imported" });
    expect(f.current().width).toBe(88);
    expect(f.values.get("tool").width).toBe(42);
    expect(f.session.view().projects).toHaveLength(2);
    f.session.dispose();
});

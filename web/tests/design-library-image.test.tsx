import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import ts from "typescript";
import type { LibraryImage } from "@/pages/design-library/library-image";

const code = ts.transpileModule(readFileSync(new URL("../src/pages/design-library/library-image.tsx", import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
}).outputText;

function harness() {
    let failed = "", writes = 0;
    const dependencies: Record<string, unknown> = {
        react: { useState: () => [failed, (value: string) => { failed = value; writes++; }] },
        "react/jsx-runtime": { jsx: (_type: unknown, props: Record<string, any>) => props },
    };
    const module = { exports: {} as { LibraryImage: typeof LibraryImage } };
    new Function("require", "module", "exports", code)((name: string) => {
        if (!Object.hasOwn(dependencies, name)) throw new Error(`Unexpected dependency: ${name}`);
        return dependencies[name];
    }, module, module.exports);
    return { render: (thumbnailUrl?: string | null) => module.exports.LibraryImage({ thumbnailUrl, contentUrl: "/original", alt: "原始设计" }) as unknown as Record<string, any>, writes: () => writes };
}

test("library covers prefer lazy thumbnails, then fall back only once to the original", () => {
    const h = harness(), first = h.render("/thumbnail");
    expect(first.src).toBe("/thumbnail"); expect(first.loading).toBe("lazy"); expect(first.decoding).toBe("async");
    first.onError(); const fallback = h.render("/thumbnail");
    expect(fallback.src).toBe("/original"); expect(fallback.alt).toBe("原始设计");
    fallback.onError(); expect(h.writes()).toBe(1); expect(h.render("/thumbnail").src).toBe("/original");
});

test("legacy entries without thumbnails retain their original source", () => {
    const h = harness();
    for (const value of [undefined, null, "", "/original"]) {
        const image = h.render(value); expect(image.src).toBe("/original"); image.onError();
    }
    expect(h.writes()).toBe(0);
});

test("a new thumbnail URL is retried after an earlier image failed", () => {
    const h = harness(); h.render("/old-thumbnail").onError();
    expect(h.render("/new-thumbnail").src).toBe("/new-thumbnail");
});

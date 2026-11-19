import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import ts from "typescript";

const file = new File(["unaltered source bytes"], "原件.png", { type: "image/png" });
const dataUrl = "data:image/png;base64,b3JpZ2luYWw=";
const durable = { url: "/api/assets/original/content", sourceAssetId: "original", sourceUrl: "/api/assets/original/content", width: 16, height: 8, bytes: file.size, mimeType: file.type, storageKey: "image:original" };

function extract(path: string, name: string, scope: Record<string, unknown>) {
    const source = ts.createSourceFile(path, readFileSync(new URL(`../src/${path}`, import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    let found = "";
    const visit = (node: ts.Node) => {
        if (ts.isFunctionDeclaration(node) && node.name?.text === name) found = node.getText(source);
        if (ts.isVariableDeclaration(node) && node.name.getText(source) === name && node.initializer) found = `const ${name} = ${node.initializer.getText(source)};`;
        ts.forEachChild(node, visit);
    };
    visit(source);
    if (!found) throw new Error(`Missing ${name}`);
    const code = ts.transpileModule(found, { compilerOptions: { target: ts.ScriptTarget.ESNext } }).outputText;
    return new Function(...Object.keys(scope), `${code}\nreturn ${name};`)(...Object.values(scope));
}

function setup(kind: "seamless" | "workbench", options: { failure?: boolean; delayed?: Promise<void> } = {}) {
    let owner = "employee-a";
    const uploads: Array<{ file: File; options: any }> = [], inserted: any[] = [];
    const controller = new AbortController();
    const current = () => owner === "employee-a" && !controller.signal.aborted;
    const scope: Record<string, unknown> = {
        ownerId: "employee-a", current, useUserStore: { getState: () => ({ user: { id: owner } }) },
        uploadUserImage: async (input: File, inputOptions: unknown) => { uploads.push({ file: input, options: inputOptions }); await options.delayed; if (options.failure) throw new Error("原件保存失败"); return durable; },
        nanoid: () => "ref", createClientUuid: () => "ref", uiText: (value: string) => value,
        loadImage: async () => ({ naturalWidth: 16, naturalHeight: 8 }),
        sourceReadRef: { current: false }, mountedRef: { current: true }, sourceRef: { current: null }, setReadingSource() {}, setSource: (value: any) => inserted.push(value),
        persistence: { assertCurrent: () => { if (!current()) throw new Error("账号身份已变化"); } }, signal: controller.signal, abortError: () => new DOMException("已停止", "AbortError"),
        FileReader: class { result = dataUrl; onload?: () => void; readAsDataURL() { queueMicrotask(() => this.onload?.()); } abort() {} },
    };
    const importImage = kind === "seamless"
        ? extract("pages/image/seamless-stitch.tsx", "setSourceFromBlob", scope).bind(null, file, file.name)
        : extract("pages/design-workbench/local/services.ts", "readImageFile", scope).bind(null, file);
    return { importImage, uploads, inserted, setOwner: (value: string) => { owner = value; } };
}

for (const kind of ["seamless", "workbench"] as const) {
    test(`${kind} archives the unchanged input for its captured owner before returning success`, async () => {
        const h = setup(kind);
        const result = await h.importImage();
        expect(h.uploads).toHaveLength(1);
        expect(h.uploads[0]!.file).toBe(file);
        expect(h.uploads[0]!.options.ownerId).toBe("employee-a");
        if (kind === "workbench") expect(result).toBe(dataUrl);
        else expect(h.inserted[0]).toMatchObject({ sourceAssetId: "original", sourceUrl: durable.url, name: file.name });
    });

    test(`${kind} propagates an original-upload error instead of succeeding locally`, async () => {
        const h = setup(kind, { failure: true });
        await expect(h.importImage()).rejects.toThrow("原件保存失败");
        expect(h.inserted).toEqual([]);
    });

    test(`${kind} does not commit a late original after the employee changes`, async () => {
        const pending = Promise.withResolvers<void>();
        const h = setup(kind, { delayed: pending.promise });
        const adding = h.importImage();
        for (let i = 0; i < 5; i++) await Promise.resolve();
        expect(h.uploads).toHaveLength(1);
        h.setOwner("employee-b"); pending.resolve();
        if (kind === "workbench") await expect(adding).rejects.toThrow("账号身份已变化");
        else await adding;
        expect(h.inserted).toEqual([]);
        expect(h.uploads[0]!.options.ownerId).toBe("employee-a");
    });
}

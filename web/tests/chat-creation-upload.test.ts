import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import ts from "typescript";

import { parseChatAttachment, type ParsedChatAttachment } from "../src/lib/chat-attachments";

type Mode = "chat" | "agent" | "create";
type Attachment = ParsedChatAttachment & { id: string };

// Run the page handlers, retaining the real parser and byte accounting. Only
// FileReader/Canvas conversion and React state updates are replaced at the edge.
const source = readFileSync(new URL("../src/pages/chat/index.tsx", import.meta.url), "utf8");
const ast = ts.createSourceFile("chat.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const initializers = new Map<string, ts.Expression>();
let byteCounter: ts.FunctionDeclaration | undefined;
const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && node.initializer) initializers.set(node.name.getText(ast), node.initializer);
    if (ts.isFunctionDeclaration(node) && node.name?.text === "dataUrlBytes") byteCounter = node;
    ts.forEachChild(node, visit);
};
visit(ast);
if (!initializers.has("addFiles") || !initializers.has("switchMode") || !byteCounter) throw new Error("The actual chat attachment handlers were not found");
const handlerCode = ts.transpileModule(`${byteCounter.getText(ast)}
exports.addFiles = ${initializers.get("addFiles")!.getText(ast)};
exports.switchMode = ${initializers.get("switchMode")!.getText(ast)};`, { compilerOptions: { target: ts.ScriptTarget.ESNext } }).outputText;

const originalBytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 7, 42, 99, 18]);
const compressedBytes = new Uint8Array([255, 216, 255, 42, 17, 11]);
const originalDataUrl = `data:image/png;base64,${Buffer.from(originalBytes).toString("base64")}`;
const compressedDataUrl = `data:image/jpeg;base64,${Buffer.from(compressedBytes).toString("base64")}`;
const MiB = 1024 * 1024;

function imageFile(name = "original.png", size?: number) {
    return new File([size === undefined ? originalBytes : new Uint8Array(size)], name, { type: "image/png" });
}

function decodedBytes(dataUrl: string) {
    return new Uint8Array(Buffer.from(dataUrl.slice(dataUrl.indexOf(",") + 1), "base64"));
}

function uploadHarness(initialMode: Mode, compressionResult = compressedDataUrl) {
    let mode = initialMode;
    let attachments: Attachment[] = [];
    let reading = false;
    let selectedModel = "chat-model";
    let nextId = 0;
    const warnings: string[] = [];
    const errors: string[] = [];
    const originalReads: File[] = [];
    const compressionReads: File[] = [];
    function renderHandlers() {
        const bindings = {
            mode,
            sessionsReady: true,
            readingAttachments: reading,
            attachments,
            sendingRef: { current: false },
            placingImageRef: { current: false },
            imageModels: [{ modelId: "image-model" }],
            chatModels: [{ modelId: "chat-model" }],
            useCallback: <T>(callback: T) => callback,
            setMode(value: Mode) { mode = value; },
            setSelectedModel(update: (current: string) => string) { selectedModel = update(selectedModel); },
            setReadingAttachments(value: boolean) { reading = value; },
            setAttachments(update: (current: Attachment[]) => Attachment[]) { attachments = update(attachments); },
            createClientId: () => `attachment-${++nextId}`,
            parseChatAttachment,
            async readFileAsDataUrl(file: File) {
                originalReads.push(file);
                return `data:${file.type};base64,${Buffer.from(await file.arrayBuffer()).toString("base64")}`;
            },
            async compressChatImage(file: File) {
                compressionReads.push(file);
                return compressionResult;
            },
            message: {
                warning(value: string) { warnings.push(value); },
                error(value: string) { errors.push(value); },
            },
        };
        const exports = {} as { addFiles: (files: FileList | null) => Promise<void>; switchMode: (mode: Mode) => void };
        new Function(...Object.keys(bindings), "exports", handlerCode)(...Object.values(bindings), exports);
        return exports;
    }
    return {
        addFiles: (files: File[]) => renderHandlers().addFiles(files as unknown as FileList),
        switchMode: (nextMode: Mode) => renderHandlers().switchMode(nextMode),
        attachments: () => attachments,
        reading: () => reading,
        mode: () => mode,
        warnings,
        errors,
        originalReads,
        compressionReads,
    };
}

describe("actual chat creation attachment upload", () => {
    test("new PNG uploads in create mode retain their original bytes and data URL", async () => {
        const page = uploadHarness("create");
        const file = imageFile();
        await page.addFiles([file]);

        expect(page.attachments()).toHaveLength(1);
        const attachment = page.attachments()[0]!;
        expect(attachment).toMatchObject({ kind: "image", name: "original.png", mimeType: "image/png", size: 12, dataUrl: originalDataUrl });
        expect(decodedBytes(attachment.dataUrl!)).toEqual(originalBytes);
        expect(page.originalReads).toEqual([file]);
        expect(page.compressionReads).toEqual([]);
        expect(page.errors).toEqual([]);
        expect(page.reading()).toBe(false);
    });

    test.each(["chat", "agent"] as Mode[])("%s uploads still use the compressed image and its stored byte size", async (mode) => {
        const page = uploadHarness(mode);
        const file = imageFile();
        await page.addFiles([file]);

        expect(page.attachments()).toHaveLength(1);
        expect(page.attachments()[0]).toMatchObject({ dataUrl: compressedDataUrl, size: 6 });
        expect(decodedBytes(page.attachments()[0]!.dataUrl!)).toEqual(compressedBytes);
        expect(page.compressionReads).toEqual([file]);
        expect(page.originalReads).toEqual([]);
        expect(page.errors).toEqual([]);
    });

    test.each(["create", "chat"] as Mode[])("%s rejects an original file over 5 MiB before conversion and retains the following valid file", async (mode) => {
        const page = uploadHarness(mode);
        const accepted = imageFile("accepted.png");
        await page.addFiles([imageFile("too-large.png", 5 * MiB + 1), accepted]);

        expect(page.attachments().map((attachment) => attachment.name)).toEqual(["accepted.png"]);
        expect([...page.originalReads, ...page.compressionReads]).toEqual([accepted]);
        expect(page.warnings).toHaveLength(1);
        expect(page.warnings[0]).toContain("5MB");
        expect(page.errors).toEqual([]);
        expect(page.reading()).toBe(false);
    });

    test.each(["create", "chat"] as Mode[])("%s accepts a file exactly at the 5 MiB original-file limit", async (mode) => {
        const page = uploadHarness(mode);
        const file = imageFile("at-limit.png", 5 * MiB);
        await page.addFiles([file]);

        expect(page.attachments().map((attachment) => attachment.name)).toEqual(["at-limit.png"]);
        expect([...page.originalReads, ...page.compressionReads]).toEqual([file]);
        expect(page.warnings).toEqual([]);
        expect(page.errors).toEqual([]);
    });

    test.each(["create", "chat"] as Mode[])("%s enforces the 8 MiB stored-attachment total across existing and new files", async (mode) => {
        const largeCompressedDataUrl = `data:image/jpeg;base64,${Buffer.from(new Uint8Array(3 * MiB)).toString("base64")}`;
        const page = uploadHarness(mode, largeCompressedDataUrl);
        await page.addFiles([imageFile("existing.png", 3 * MiB)]);
        await page.addFiles([imageFile("fits.png", 3 * MiB), imageFile("exceeds-total.png", 3 * MiB)]);

        expect(page.attachments().map((attachment) => attachment.name)).toEqual(["existing.png", "fits.png"]);
        expect(page.attachments().reduce((total, attachment) => total + attachment.size, 0)).toBe(6 * MiB);
        expect(page.warnings).toHaveLength(1);
        expect(page.warnings[0]).toContain("8MB");
        expect(page.errors).toEqual([]);
        expect(page.reading()).toBe(false);
    });

    test("create accepts exactly 8 MiB of stored attachments and rejects the next byte-bearing file", async () => {
        const page = uploadHarness("create");
        // Image byte accounting rounds padded base64 upward. Divisible-by-three
        // image sizes plus a two-byte text file exercise the exact shared limit.
        await page.addFiles([
            new File(["ok"], "note.txt", { type: "text/plain" }),
            imageFile("first.png", 3 * MiB),
            imageFile("second.png", 5 * MiB - 2),
        ]);
        expect(page.attachments().reduce((total, attachment) => total + attachment.size, 0)).toBe(8 * MiB);
        expect(page.warnings).toEqual([]);

        await page.addFiles([new File(["x"], "over-limit.txt", { type: "text/plain" })]);
        expect(page.attachments().map((attachment) => attachment.name)).toEqual(["note.txt", "first.png", "second.png"]);
        expect(page.warnings).toHaveLength(1);
        expect(page.warnings[0]).toContain("8MB");
        expect(page.errors).toEqual([]);
    });

    test("switching a compressed chat attachment to create mode cannot pretend to restore its original bytes", async () => {
        const page = uploadHarness("chat");
        await page.addFiles([imageFile("chat-upload.png")]);
        const existing = page.attachments()[0]!;

        page.switchMode("create");
        expect(page.mode()).toBe("create");
        expect(page.attachments()).toEqual([existing]);
        expect(page.attachments()[0]!.dataUrl).toBe(compressedDataUrl);
        expect(page.originalReads).toEqual([]);
        expect(page.compressionReads).toHaveLength(1);

        await page.addFiles([imageFile("fresh-create-upload.png")]);
        expect(page.attachments()[0]).toBe(existing);
        expect(decodedBytes(page.attachments()[0]!.dataUrl!)).toEqual(compressedBytes);
        expect(page.attachments()[1]!.dataUrl).toBe(originalDataUrl);
        expect(decodedBytes(page.attachments()[1]!.dataUrl!)).toEqual(originalBytes);
        expect(page.compressionReads).toHaveLength(1);
        expect(page.originalReads).toHaveLength(1);
    });
});

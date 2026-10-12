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
if (!initializers.has("addFiles") || !byteCounter) throw new Error("The actual chat attachment handler was not found");
const handlerCode = ts.transpileModule(`${byteCounter.getText(ast)}
exports.addFiles = ${initializers.get("addFiles")!.getText(ast)};`, { compilerOptions: { target: ts.ScriptTarget.ESNext } }).outputText;

const originalBytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 7, 42, 99, 18]);
const originalDataUrl = `data:image/png;base64,${Buffer.from(originalBytes).toString("base64")}`;
const MiB = 1024 * 1024;

function imageFile(name = "original.png", size?: number) {
    return new File([size === undefined ? originalBytes : new Uint8Array(size)], name, { type: "image/png" });
}

function decodedBytes(dataUrl: string) {
    return new Uint8Array(Buffer.from(dataUrl.slice(dataUrl.indexOf(",") + 1), "base64"));
}

function uploadHarness(legacyMode: Mode) {
    let attachments: Attachment[] = [];
    let reading = false;
    let nextId = 0;
    const warnings: string[] = [];
    const errors: string[] = [];
    const originalReads: File[] = [];
    const compressionReads: File[] = [];
    function renderHandlers() {
        const bindings = {
            mode: legacyMode,
            sessionsReady: true,
            readingAttachments: reading,
            attachments,
            sendingRef: { current: false },
            placingImageRef: { current: false },
            imageModels: [{ modelId: "image-model" }],
            chatModels: [{ modelId: "chat-model" }],
            useCallback: <T>(callback: T) => callback,
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
                throw new Error("Uploaded originals must never be recompressed by the chat page");
            },
            message: {
                warning(value: string) { warnings.push(value); },
                error(value: string) { errors.push(value); },
            },
        };
        const exports = {} as { addFiles: (files: FileList | null) => Promise<void> };
        new Function(...Object.keys(bindings), "exports", handlerCode)(...Object.values(bindings), exports);
        return exports;
    }
    return {
        addFiles: (files: File[]) => renderHandlers().addFiles(files as unknown as FileList),
        attachments: () => attachments,
        reading: () => reading,
        warnings,
        errors,
        originalReads,
        compressionReads,
    };
}

describe("actual unified chat attachment upload", () => {
    test("new PNG uploads retain their original bytes and data URL", async () => {
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

    test.each(["chat", "agent"] as Mode[])("legacy %s session uploads also retain the original image and its byte size", async (mode) => {
        const page = uploadHarness(mode);
        const file = imageFile();
        await page.addFiles([file]);

        expect(page.attachments()).toHaveLength(1);
        expect(page.attachments()[0]).toMatchObject({ dataUrl: originalDataUrl, size: 12 });
        expect(decodedBytes(page.attachments()[0]!.dataUrl!)).toEqual(originalBytes);
        expect(page.compressionReads).toEqual([]);
        expect(page.originalReads).toEqual([file]);
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
        const page = uploadHarness(mode);
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

    test("adding another image preserves the earlier original attachment without copying or recompressing it", async () => {
        const page = uploadHarness("chat");
        await page.addFiles([imageFile("chat-upload.png")]);
        const existing = page.attachments()[0]!;

        expect(page.attachments()).toEqual([existing]);
        expect(page.attachments()[0]!.dataUrl).toBe(originalDataUrl);
        expect(page.originalReads).toHaveLength(1);
        expect(page.compressionReads).toHaveLength(0);

        await page.addFiles([imageFile("fresh-create-upload.png")]);
        expect(page.attachments()[0]).toBe(existing);
        expect(decodedBytes(page.attachments()[0]!.dataUrl!)).toEqual(originalBytes);
        expect(page.attachments()[1]!.dataUrl).toBe(originalDataUrl);
        expect(decodedBytes(page.attachments()[1]!.dataUrl!)).toEqual(originalBytes);
        expect(page.compressionReads).toHaveLength(0);
        expect(page.originalReads).toHaveLength(2);
    });

    test("an unsupported file does not discard a following valid image or leave attachment reading locked", async () => {
        const page = uploadHarness("chat");
        await page.addFiles([new File(["bad"], "unsupported.exe", { type: "application/octet-stream" }), imageFile()]);
        expect(page.errors).toHaveLength(1);
        expect(page.attachments()).toHaveLength(1);
        expect(page.attachments()[0]!.dataUrl).toBe(originalDataUrl);
        expect(page.reading()).toBe(false);
    });
});

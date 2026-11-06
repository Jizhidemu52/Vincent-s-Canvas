import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { canvasImageAgentTaskSignature } from "../src/lib/canvas/canvas-image-agent";

test("canvas image-agent task signature works without secure-context Web Crypto", async () => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, "crypto");
    Object.defineProperty(globalThis, "crypto", { configurable: true, value: { subtle: undefined } });
    try {
        const value = { prompt: "提取出平面平铺图 🧶", references: ["source-577x591"], model: "server-model", count: 1 };
        expect(await canvasImageAgentTaskSignature(value)).toBe(createHash("sha256").update(JSON.stringify(value)).digest("hex"));
        expect(await canvasImageAgentTaskSignature(value)).toBe(await canvasImageAgentTaskSignature(value));
        expect(await canvasImageAgentTaskSignature({ ...value, prompt: "只改红色数字" })).not.toBe(await canvasImageAgentTaskSignature(value));
        expect(await canvasImageAgentTaskSignature({ ...value, references: ["different-original"] })).not.toBe(await canvasImageAgentTaskSignature(value));
    } finally {
        if (descriptor) Object.defineProperty(globalThis, "crypto", descriptor);
        else Reflect.deleteProperty(globalThis, "crypto");
    }
});

test("signatures preserve the existing SHA-256 JSON contract and do not access browser crypto", async () => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, "crypto");
    Object.defineProperty(globalThis, "crypto", { configurable: true, get: () => { throw new Error("Browser crypto must not be required"); } });
    try {
        for (const value of [{}, [], null, "服装", { nested: { id: "a", size: "auto" } }]) {
            expect(await canvasImageAgentTaskSignature(value)).toBe(createHash("sha256").update(JSON.stringify(value)).digest("hex"));
        }
    } finally {
        if (descriptor) Object.defineProperty(globalThis, "crypto", descriptor);
        else Reflect.deleteProperty(globalThis, "crypto");
    }
});

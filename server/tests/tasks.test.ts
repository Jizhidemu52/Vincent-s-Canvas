import { describe, expect, test } from "bun:test";
import { queueScore } from "../src/tasks";

describe("task queue priority", () => {
    test("orders urgent before priority and normal while preserving FIFO time", () => {
        expect(queueScore("urgent", 200)).toBeLessThan(queueScore("priority", 100));
        expect(queueScore("priority", 200)).toBeLessThan(queueScore("normal", 100));
        expect(queueScore("normal", 100)).toBeLessThan(queueScore("normal", 200));
    });
});

import { describe, expect, test } from "bun:test";

import { restoreBatchItemIndices } from "../src/services/api/generation-tasks";

describe("canvas batch item mapping", () => {
    test("keeps original file positions after an earlier upload fails", () => {
        const result = restoreBatchItemIndices(
            [{ itemIndex: 0 }, { itemIndex: 2 }, { itemIndex: 3 }],
            [
                { id: "task-a", itemIndex: 0 },
                { id: "task-c", itemIndex: 1 },
            ],
            [{ index: 2, reason: "任务创建失败" }],
        );

        expect(result.tasks).toEqual([
            { id: "task-a", itemIndex: 0 },
            { id: "task-c", itemIndex: 2 },
        ]);
        expect(result.failures).toEqual([{ index: 3, reason: "任务创建失败" }]);
    });
});

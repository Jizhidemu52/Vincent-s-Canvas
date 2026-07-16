import { describe, expect, test } from "bun:test";

import { restoreBatchItemIndices } from "../src/services/api/generation-tasks";
import { imageTaskParameters } from "../src/services/api/image";

describe("canvas batch item mapping", () => {
    test("maps image sizes to GPT-Image-2 ratios and resolutions", () => {
        expect(imageTaskParameters({ size: "2048x1152" } as never)).toEqual({ size: "16:9", resolution: "2k" });
        expect(imageTaskParameters({ size: "2160x3840" } as never)).toEqual({ size: "9:16", resolution: "4k" });
        expect(imageTaskParameters({ size: "auto" } as never)).toEqual({ size: "1:1", resolution: "1k" });
    });

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

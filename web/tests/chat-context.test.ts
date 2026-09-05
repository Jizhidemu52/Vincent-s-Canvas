import { describe, expect, test } from "bun:test";

import { latestChatContext } from "../src/lib/chat-context";

describe("chat context window", () => {
    test("keeps the newest messages within a bounded model context", () => {
        const result = latestChatContext([
            { role: "user", content: "old" },
            { role: "assistant", content: "middle" },
            { role: "user", content: "new" },
        ], 2, 100);

        expect(result.map((item) => item.content)).toEqual(["middle", "new"]);
    });

    test("marks a message that exhausts the remaining character budget", () => {
        const result = latestChatContext([{ role: "user", content: "abcdefghij" }], 4, 8);

        expect(result[0]?.content).toContain("已截断");
        expect(result[0]?.content.length).toBeLessThanOrEqual(8);
    });
});

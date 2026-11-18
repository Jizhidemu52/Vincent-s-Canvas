import { describe, expect, test } from "bun:test";
import { designSessionRequest } from "../src/components/canvas/design-discussion/design-session.mjs";
import { messageTasks, resultDiscussionReference } from "../src/components/canvas/design-discussion/discussion-thread.mjs";

const proposal = { id: "p2", title: "克制的灰蓝", features: ["低饱和衣身", "白领保持"], rationale: "降低运动感，保留原图识别度。" };
const message = { id: "reply", role: "assistant", content: "第二个方向更适合你。", referenceSnapshot: [], proposals: [proposal], questions: [{ id: "q1", question: "更偏通勤还是运动？", options: ["通勤", "运动"] }], proposalBatchId: "batch" };
const session = { id: "session", history: [message], proposalBatch: null };
const task = { id: "local", taskId: "server", discussionSessionId: "session", discussionMessageId: "reply", proposal: { ...proposal, batchId: "batch" }, status: "success", mediaKind: "image", resultUrls: ["/api/assets/11111111-1111-4111-8111-111111111111/content"], references: [{ id: "source" }] };

describe("continuous design discussion", () => {
    test("follow-up carries actual proposal features and the question, not just the reply summary", () => {
        const request = designSessionRequest({ prompt: "第二个再克制一点", history: [message], references: [], previews: [] });
        const prior = request.input.find((entry: { role: string }) => entry.role === "assistant");
        expect(prior.content).toContain("低饱和衣身");
        expect(prior.content).toContain("更偏通勤还是运动");
        expect(prior.content).toContain("不是用户已选择或已生成");
        expect(request.tools).toEqual([]);
    });
    test("result remains attached to its original reply after further discussion", () => {
        const continued = { ...session, history: [message, { id: "next", role: "assistant", content: "可以减少对比。" }] };
        expect(messageTasks(continued, message, 0, [task])).toEqual([task]);
        expect(messageTasks(continued, continued.history[1], 1, [task])).toEqual([]);
        expect(messageTasks(continued, message, 0, [{ ...task, discussionSessionId: "another" }])).toEqual([]);
    });
    test("existing batch receipts retain their inline result without creating any request", () => {
        const older = { role: "assistant", content: "已有方案" };
        const previous = { id: "session", history: [older], proposalBatch: { id: "batch" } };
        expect(messageTasks(previous, older, 0, [{ ...task, discussionMessageId: undefined, discussionSessionId: undefined }])).toHaveLength(1);
    });
    test("discussing a result uses the actual owned result asset as the new base", () => {
        expect(resultDiscussionReference(task, 0)).toMatchObject({ id: "design-local-0", image: task.resultUrls[0], role: "base", kind: "result", parentId: "source", taskId: "server" });
        for (const invalid of [{ ...task, status: "failed" }, { ...task, mediaKind: "video" }, { ...task, resultUrls: ["https://foreign.invalid/image.png"] }]) expect(() => resultDiscussionReference(invalid, 0)).toThrow("尚无");
    });
});

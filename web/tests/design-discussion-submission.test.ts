import { describe, expect, test } from "bun:test";
import { assertProposalSubmission, proposalSubmission, proposalSubmissionMessage } from "../src/components/canvas/design-discussion/proposal-submission.mjs";

describe("proposal submission receipts", () => {
    test.each(["failed", "uncertain", "submitting", "paused", "cancelled", "unexpected"])("%s preserves the original failure and blocks continuation", status => {
        const receipt = proposalSubmission({ id: "local-task", requestId: "original-request", status, failureReason: "视频首帧需要公开素材 URL", extra: "not persisted" });
        expect(receipt).toEqual({ id: "local-task", requestId: "original-request", status, failureReason: "视频首帧需要公开素材 URL" });
        expect(() => assertProposalSubmission(receipt)).toThrow("视频首帧需要公开素材 URL");
        expect(() => assertProposalSubmission(receipt)).toThrow("不会重复生成");
        expect(proposalSubmissionMessage(receipt)).not.toContain("已完成");
    });

    test.each(["waiting", "processing", "success"])("only a confirmed %s receipt can continue the batch", status => {
        expect(() => assertProposalSubmission({ id: "task", requestId: "request", status })).not.toThrow();
    });

    test("old string receipts remain recorded without inventing a confirmed status", () => {
        expect(proposalSubmission("original-task")).toEqual({ id: "original-task", requestId: "", status: "unknown", failureReason: "" });
        expect(proposalSubmissionMessage("original-task")).toBe("请求已记录，状态待核实");
        expect(() => assertProposalSubmission("original-task")).toThrow("状态待核实");
    });

    test("a missing task identifier cannot be claimed as a successful receipt", () => {
        expect(() => assertProposalSubmission({ status: "success" })).toThrow("状态待核实");
        expect(proposalSubmission(null).status).toBe("unknown");
    });
});

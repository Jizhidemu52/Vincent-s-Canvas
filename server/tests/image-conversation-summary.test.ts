import { expect, test } from "bun:test";
import type { ContextSummary } from "../../shared/image-conversation-contracts";
import { compactConversationSummary, type ConversationSummaryMessage } from "../src/image-conversation-summary";

const empty: ContextSummary = { schemaVersion: 1, text: "", goals: [], unresolvedQuestions: [] };
const sourceTurnId = "f8db0865-97cd-4f19-8697-b26b4b844777";
const message = (seq: number, text = `原文 ${seq}`, role: "user" | "assistant" = "user"): ConversationSummaryMessage =>
  ({ seq, turn_id: sourceTurnId, role, kind: "text", text, original_characters: Array.from(text).length });

test("bounded summary keeps exact attributed user and assistant excerpts without declaring suggestions adopted", () => {
  const rows = [message(1, "  保留七颗纽扣\n不要改结构  "), message(2, "可以考虑改成拉链。", "assistant")];
  const snapshot = structuredClone(rows);
  const result = compactConversationSummary(empty, 0, rows, false);
  const document = JSON.parse(result.summary.text);
  expect(result.throughSeq).toBe(2);
  expect(document.excerpts).toEqual([
    { seq: 1, sourceTurnId, role: "user", kind: "text", text: rows[0]!.text, omittedCharacters: 0 },
    { seq: 2, sourceTurnId, role: "assistant", kind: "text", text: rows[1]!.text, omittedCharacters: 0 },
  ]);
  expect(document.notice).toContain("不代表用户采纳");
  expect(document.notice).toContain("不是完整记忆");
  expect(result.summary.goals).toEqual([]);
  expect(result.summary.unresolvedQuestions).toEqual([]);
  expect(rows).toEqual(snapshot);
});

test("serialized summary remains below 8K and explicitly marks truncated text, omitted sources and unfinished history", () => {
  const rows = Array.from({ length: 40 }, (_, index) => ({ ...message(index + 1, "原文😀\n".repeat(600), index % 2 ? "assistant" : "user"), original_characters: 20_000 }));
  const first = compactConversationSummary(empty, 0, rows, true);
  const firstDocument = JSON.parse(first.summary.text);
  expect(JSON.stringify(first.summary).length).toBeLessThanOrEqual(8_000);
  expect(first.throughSeq).toBe(40);
  expect(firstDocument.hasUnprocessedHistory).toBe(true);
  expect(firstDocument.omittedMessages).toBeGreaterThan(0);
  expect(firstDocument.excerpts.every((entry: any) => Array.from(entry.text).length <= 600 && entry.omittedCharacters > 0)).toBe(true);
  expect(firstDocument.excerpts.at(-1).seq).toBe(40);
  const original = JSON.stringify(first.summary);
  const next = compactConversationSummary(first.summary, first.throughSeq, Array.from({ length: 40 }, (_, index) => message(index + 41)), false);
  const nextDocument = JSON.parse(next.summary.text);
  expect(JSON.stringify(next.summary).length).toBeLessThanOrEqual(8_000);
  expect(next.throughSeq).toBe(80);
  expect(nextDocument.hasUnprocessedHistory).toBe(false);
  expect(nextDocument.omittedMessages).toBeGreaterThanOrEqual(firstDocument.omittedMessages);
  expect(nextDocument.excerpts.at(-1).seq).toBe(80);
  expect(new Set(nextDocument.excerpts.map((entry: any) => entry.seq)).size).toBe(nextDocument.excerpts.length);
  expect(JSON.stringify(first.summary)).toBe(original);
});

test("an empty increment is unchanged and unproven previous prose is not promoted to sourced user instructions", () => {
  const previous = { ...empty, text: "助手曾建议改变结构，但用户没有采纳。" };
  expect(compactConversationSummary(previous, 12, [], false)).toEqual({ summary: previous, throughSeq: 12 });
  const next = compactConversationSummary(previous, 12, [message(13)], false);
  expect(JSON.parse(next.summary.text).priorSummaryOmitted).toBe(true);
  expect(JSON.parse(next.summary.text).excerpts).toHaveLength(1);
  expect(next.summary.text).not.toContain(previous.text);
});

test("increment ordering, declared source length and per-run read bounds are enforced", () => {
  expect(() => compactConversationSummary(empty, 5, [message(5)], false)).toThrow();
  expect(() => compactConversationSummary(empty, 0, [message(2), message(1)], false)).toThrow();
  expect(() => compactConversationSummary(empty, 0, [{ ...message(1), original_characters: -1 }], false)).toThrow();
  expect(() => compactConversationSummary(empty, 0, Array.from({ length: 41 }, (_, index) => message(index + 1)), false)).toThrow();
});

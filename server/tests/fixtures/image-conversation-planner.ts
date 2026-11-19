import type { ImageConversationPlannerContext } from "../../src/image-conversation-planner";
import type { PlannerPlan } from "../../../shared/image-conversation-contracts";
import type { ChatCompletionResult, ResponseInput } from "../../src/routes/chat";

export const plannerIds = {
  conversation: "10000000-0000-4000-8000-000000000001", original: "20000000-0000-4000-8000-000000000001",
  current: "20000000-0000-4000-8000-000000000002", reference: "20000000-0000-4000-8000-000000000003", outside: "20000000-0000-4000-8000-000000000099",
};
export const plannerState = { schemaVersion: 1 as const, goals: ["商品款式调整"], constraints: [{ key: "color", text: "保留红色", source: "user" as const, sourceTurnId: null }] };
export const plannerText = "把领口改成V领，保留红色";
export function plannerContext(): ImageConversationPlannerContext {
  return {
    conversationId: plannerIds.conversation, currentUserText: plannerText, inputActiveVersionId: plannerIds.current,
    requestedState: structuredClone(plannerState), contextSummary: { schemaVersion: 1, text: "正在修改领口", goals: [], unresolvedQuestions: [] },
    manifest: { schemaVersion: 1, summaryThroughSeq: 0, messageSeqs: [1, 2], inputActiveVersionId: plannerIds.current, baseVersionId: plannerIds.current,
      sourceStateVersionId: plannerIds.current, images: [{ versionId: plannerIds.current, assetId: "30000000-0000-4000-8000-000000000001", role: "current", previewed: true }],
      attachments: [], omittedHistory: false, policyVersion: "image-conversation-v1" },
    versions: [
      { id: plannerIds.original, label: "图1/V1", rootVersionId: plannerIds.original, parentVersionId: null, versionNo: 1, imageNo: 1, requestedState: structuredClone(plannerState), previewed: false },
      { id: plannerIds.current, label: "图1/V2", rootVersionId: plannerIds.original, parentVersionId: plannerIds.original, versionNo: 2, imageNo: 2, requestedState: structuredClone(plannerState), previewed: true },
      { id: plannerIds.reference, label: "图2/V1", rootVersionId: plannerIds.reference, parentVersionId: null, versionNo: 1, imageNo: 3, requestedState: { schemaVersion: 1, goals: [], constraints: [] }, previewed: false },
    ],
  };
}
export function plannerMessages(text = plannerText): ResponseInput[] {
  return [{ role: "assistant", content: "可以继续修改。" }, { role: "user", content: [{ type: "input_text", text: "图1/V2 当前真实预览" }, { type: "input_image", image_url: "data:image/png;base64,AQID" }] }, { role: "user", content: text }];
}
export function plannerEdit(): PlannerPlan {
  return { action: "edit", assistantText: "将当前图领口改为V领，保留配色。", base: { kind: "current" }, stateSource: "base",
    changes: [{ kind: "set", target: "neckline", instruction: "把领口改成V领" }], preserve: ["红色"], revoke: [], references: [], outputIntent: { purpose: "standard", complexity: "low" } };
}
export function plannerReply(plan: PlannerPlan = plannerEdit()): ChatCompletionResult {
  return { content: "", toolCalls: [{ id: "planner-call", type: "function", function: { name: "plan_image_conversation", arguments: JSON.stringify({ plan }) } }], stopReason: "tool_calls" };
}

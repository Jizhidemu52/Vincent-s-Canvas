import { describe, expect, test } from "bun:test";
import { BillingError } from "../src/billing";
import { ImageConversationContextError } from "../src/image-conversation-context";
import { ImageConversationPlannerError } from "../src/image-conversation-planner";
import { classifyImageConversationError } from "../src/image-conversation-runtime";
import { ImageConversationError } from "../src/image-conversation-store";
import { ImageConversationSummaryFenceError } from "../src/image-conversation-summary";
import { ImageOutputPolicyError } from "../src/image-output-policy";
import { ModuleDisabledError } from "../src/module-flags";
import { PromptOptimizationError } from "../src/prompt-safety";
import { ToolConfigurationError } from "../src/tool-configuration";

describe("image conversation runtime error classification", () => {
  test.each(["not_submitted", "rejected"] as const)("explicit %s planner outcomes are failed, not unknown or automatically retryable", outcome => {
    const error = new ImageConversationPlannerError("PLANNER_BINDING_CHANGED", "模型绑定已变化", outcome, 409);
    expect(classifyImageConversationError(error)).toEqual({ code: "PLANNER_FAILED", message: error.message, retryable: false });
    expect(classifyImageConversationError(new ImageConversationPlannerError("PLANNER_OUTCOME_UNKNOWN", "已确认未产生有效规划", outcome)))
      .toEqual({ code: "PLANNER_FAILED", message: "已确认未产生有效规划", retryable: false });
  });

  test("unknown dispatch takes precedence over an optimistic code and never authorizes retry", () => {
    for (const code of ["PLANNER_FAILED", "PLANNER_OUTCOME_UNKNOWN", "INSUFFICIENT_CREDIT"]) {
      expect(classifyImageConversationError(new ImageConversationPlannerError(code, "结果待核查", "unknown")))
        .toEqual({ code: "PLANNER_OUTCOME_UNKNOWN", message: "结果待核查", retryable: false });
    }
  });

  test("the billing implementation's singular insufficient-credit code maps to the public contract", () => {
    const billing = new BillingError("INSUFFICIENT_CREDIT", "可用积分不足");
    const expected = { code: "INSUFFICIENT_CREDITS", message: billing.message, retryable: false } as const;
    expect(classifyImageConversationError(billing)).toEqual(expected);
    expect(classifyImageConversationError(new ImageConversationPlannerError(billing.code, billing.message, "not_submitted"))).toEqual(expected);
    expect(classifyImageConversationError(new ImageConversationPlannerError("INSUFFICIENT_CREDITS", billing.message, "rejected"))).toEqual(expected);
  });

  test("context validation errors are distinct from provider uncertainty", () => {
    expect(classifyImageConversationError(new ImageConversationContextError("ASSET_NOT_READY", "图片不可读取")))
      .toEqual({ code: "ASSET_NOT_READY", message: "图片不可读取", retryable: false });
    expect(classifyImageConversationError(new ImageConversationContextError("PLANNER_CONTEXT_INVALID", "当前原文已改变")))
      .toEqual({ code: "PLAN_INVALID", message: "当前原文已改变", retryable: false });
    const staleSummary = new ImageConversationSummaryFenceError();
    expect(classifyImageConversationError(staleSummary))
      .toEqual({ code: "PLAN_INVALID", message: staleSummary.message, retryable: false });
  });

  test.each(["OUTPUT_SETTINGS_INVALID", "MODEL_BINDING_UNAVAILABLE", "MODEL_CAPABILITY_MISMATCH", "ASSET_NOT_READY", "PRICE_UNAVAILABLE", "INSUFFICIENT_CREDITS"] as const)(
    "output policy %s remains a bounded public failure", code => {
      const error = new ImageOutputPolicyError(code, "fixture-reason", "参数不可执行");
      expect(classifyImageConversationError(error)).toEqual({ code: code === "PRICE_UNAVAILABLE" ? "OUTPUT_SETTINGS_INVALID" : code, message: error.message, retryable: false });
    },
  );

  test.each(["ASSET_NOT_READY", "MODEL_BINDING_UNAVAILABLE", "MODEL_CAPABILITY_MISMATCH", "CONVERSATION_REVISION_CONFLICT"] as const)(
    "conversation %s errors never become an unknown provider outcome", code => {
      const error = new ImageConversationError(409, code, "会话已改变");
      expect(classifyImageConversationError(error)).toEqual({ code: code === "CONVERSATION_REVISION_CONFLICT" ? "PLAN_INVALID" : code, message: error.message, retryable: false });
    },
  );

  test("configuration and private-profile preflight failures are non-retryable binding failures", () => {
    const errors = [new ToolConfigurationError("MODEL_DISABLED", "模型停用"), new ModuleDisabledError("gpt-chat"), new PromptOptimizationError("PLANNER_CONTEXT_INVALID", "资料无效", 422)];
    for (const error of errors) expect(classifyImageConversationError(error)).toEqual({ code: "MODEL_BINDING_UNAVAILABLE", message: error.message, retryable: false });
  });

  test("untyped errors and code-shaped objects stay unclassified so worker dispatch evidence decides uncertainty", () => {
    for (const error of [undefined, null, "failure", new Error("transport detail"), { code: "PLANNER_FAILED", dispatchOutcome: "not_submitted", message: "untrusted" }]) {
      expect(classifyImageConversationError(error)).toBeUndefined();
    }
  });
});

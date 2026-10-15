import { describe, expect, test } from "bun:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import ts from "typescript";

// Extract only pure guards and the intercepted-route callback. Never import or execute the paid runner.
const source = readFileSync(new URL("../scripts/mark-paid-browser-qa.mjs", import.meta.url), "utf8");
const ast = ts.createSourceFile("mark-paid-browser-qa.mjs", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const helperNames = ["planningToolName", "prepareChatPlanReplay", "validateReplayPlanningPayload"];
const helpers = ast.statements.filter(ts.isFunctionDeclaration).filter(node => helperNames.includes(node.name!.text)).map(node => node.getText(ast)).join("\n");
const routeStatement = ast.statements.find(node => ts.isExpressionStatement(node) && ts.isAwaitExpression(node.expression)
    && ts.isCallExpression(node.expression.expression) && node.expression.expression.expression.getText(ast) === "context.route") as ts.ExpressionStatement;
const routeCall = (routeStatement.expression as ts.AwaitExpression).expression as ts.CallExpression;
const routeText = routeCall.arguments[1]!.getText(ast);
const factory = new Function("assert", "createHash", `${helpers}
    return { planningToolName, prepareChatPlanReplay, validateReplayPlanningPayload,
      routeHarness(ledger, active, savedPlanReplay) {
        const group = 'chat', errors = [], planRequests = new Map(); let replayedPlanningResponses = 0, persists = 0;
        const modelIds = [1, 2, 3].map(n => 'd5000000-0000-4000-8000-00000000000' + n);
        const chatModelId = 'd5000000-0000-4000-8000-000000000004', videoModelId = 'd5000000-0000-4000-8000-000000000005';
        const persist = async () => { persists++; }; const console = { log() {} };
        const handle = ${routeText}; return { handle, errors, planRequests, stats: () => ({ persists, replayedPlanningResponses }) };
      }
    };`)(assert, createHash) as any;

const attachmentId = "179efadd-8f2f-4ba6-b2a1-722f7124887d";
const sourceCaseId = "chat-knit-A-responses";
function fixture() {
    return { limit: 50, submitted: 38, cases: [
        { id: "image-knit-A", outputs: [{ filename: "image-knit-A-1.png", sha256: "a".repeat(64) }] },
        { id: sourceCaseId, tool: "gpt-chat-image", planningCalls: 1, status: "needs-review", error: "Old runner false negative" },
        { id: `${sourceCaseId}-plan-1`, parentId: sourceCaseId, status: "success", httpStatus: 200, submissionStarted: "recorded", modelId: "d5000000-0000-4000-8000-000000000004",
            response: { content: "Changing only the collar.", stopReason: "tool_calls", toolCalls: [{ id: "call-paid", type: "function", function: { name: "create_image", arguments: JSON.stringify({ action: "edit", target_image_id: attachmentId, prompt: "Change only the collar.", preserve: ["knit"] }) } }],
                responsesOutputItems: [{ id: "rs-paid", type: "reasoning", summary: [], encrypted_content: "opaque" }, { id: "fc-paid", type: "function_call", call_id: "call-paid", name: "create_image", arguments: "unchanged-native-value" }] } },
    ] } as any;
}
function planningPayload() {
    return { modelId: "d5000000-0000-4000-8000-000000000004", toolKey: "gpt-chat", tools: [{ type: "function", name: "create_image", parameters: {} }],
        input: [{ role: "user", content: [{ type: "input_text", text: `[图片预览 image_id=${attachmentId}; 图 1; name=image-knit-A-1.png]` }, { type: "input_image", image_url: "data:image/png;base64,AQID" }] }] };
}
function requestRoute(path: string, payload: unknown) {
    const result = { continues: 0, aborts: 0, fulfilled: [] as any[] };
    return { result, request: () => ({ method: () => "POST", url: () => `http://127.0.0.1:5190${path}`, postDataJSON: () => payload }),
        continue: async () => { result.continues++; }, abort: async () => { result.aborts++; }, fulfill: async (body: any) => { result.fulfilled.push(body); } };
}

describe("paid QA runner offline safety guards", () => {
    test("changes exact pixels to a ratio before selecting an enabled resolution", async () => {
        const chooseText = ast.statements.filter(ts.isFunctionDeclaration).find(node => node.name?.text === "choose")!.getText(ast);
        const events: string[] = [];
        const control = (label: string): any => ({ first: () => control(label), count: async () => 0,
            click: async () => { events.push(`click:${label}`); },
            selectOption: async (value: string) => {
                if (label === "清晰度 / 分辨率") assert.ok(events.includes("select:宽高比:1:1"), "Exact-pixel resolution is disabled");
                events.push(`select:${label}:${value}`);
            } });
        const page = { locator: control, getByRole: (_role: string, options: any) => control(String(options.name)), getByLabel: control };
        const choose = new Function("page", "modelNames", `${chooseText}; return choose;`)(page, ["aplmart-gpt2.5-flare"]);
        await choose(0, "high", "1k");
        expect(events.slice(-3)).toEqual(["select:宽高比:1:1", "select:清晰度 / 分辨率:1k", "select:图片质量:high"]);
    });
    test("detects the actual nested tool-call contract, not only a nonexistent top-level name", () => {
        expect(factory.planningToolName({ type: "function", function: { name: "create_image" } })).toBe("create_image");
        expect(factory.planningToolName({ type: "function", function: { name: "inspect_images" } })).toBe("inspect_images");
        expect(factory.planningToolName({ name: "create_image" })).toBe("create_image");
        expect(factory.planningToolName(null)).toBe("");
    });
    test("prepares an exact saved response without mutating or rewriting the paid failure record", () => {
        const ledger = fixture(), before = JSON.stringify(ledger);
        const replay = factory.prepareChatPlanReplay(ledger);
        expect(replay.responseJson).toBe(JSON.stringify(ledger.cases[2].response));
        expect(replay.attachmentId).toBe(attachmentId);
        expect(replay.replayCaseId).toBe("chat-knit-A-responses-plan-replay-v2");
        expect(JSON.stringify(ledger)).toBe(before);
    });
    test.each(["already-submitted", "wrong-model", "inspection", "missing-source-hash", "multi-plan", "extra-reference"])("refuses unsafe replay source %s", kind => {
        const ledger = fixture();
        if (kind === "already-submitted") ledger.cases[1].taskId = "existing-image-task";
        if (kind === "wrong-model") ledger.cases[2].modelId = "different-provider";
        if (kind === "inspection") ledger.cases[2].response.toolCalls[0].function.name = "inspect_images";
        if (kind === "missing-source-hash") delete ledger.cases[0].outputs[0].sha256;
        if (kind === "multi-plan") ledger.cases.push({ parentId: sourceCaseId });
        if (kind === "extra-reference") ledger.cases[2].response.toolCalls[0].function.arguments = JSON.stringify({ action: "edit", target_image_id: attachmentId, prompt: "Edit", preserve: [], reference_image_ids: ["other"] });
        expect(() => factory.prepareChatPlanReplay(ledger)).toThrow();
    });
    test("replay fulfills exactly the paid response locally and blocks a second planner request", async () => {
        const ledger = fixture(), replay = factory.prepareChatPlanReplay(ledger), active = { id: replay.replayCaseId, tool: "gpt-chat-image" } as any;
        const harness = factory.routeHarness(ledger, active, replay);
        const first = requestRoute("/api/chat/responses", planningPayload()); await harness.handle(first);
        expect(first.result.continues).toBe(0); expect(first.result.fulfilled[0].status).toBe(200);
        expect(first.result.fulfilled[0].body).toBe(replay.responseJson);
        expect(active.planningReplay.newChatCharges).toBe(0); expect(ledger.submitted).toBe(38); expect(ledger.cases).toHaveLength(3);
        const second = requestRoute("/api/chat/responses", planningPayload()); await harness.handle(second);
        expect(second.result.continues).toBe(0); expect(second.result.fulfilled[0].status).toBe(409); expect(ledger.submitted).toBe(38);
    });
    test("wrong reconstructed attachment identity never reaches the real chat server", async () => {
        const ledger = fixture(), replay = factory.prepareChatPlanReplay(ledger), active = { id: replay.replayCaseId, tool: "gpt-chat-image" };
        const harness = factory.routeHarness(ledger, active, replay), payload = planningPayload();
        payload.input[0]!.content[0]!.text = "[图片预览 image_id=different; 图 1; name=image-knit-A-1.png]";
        const route = requestRoute("/api/chat/responses", payload); await harness.handle(route);
        expect(route.result.continues).toBe(0); expect(route.result.fulfilled[0].status).toBe(409); expect(ledger.submitted).toBe(38);
    });
    test("only the exact paid plan's single Sunburst image can use one new budget slot", async () => {
        const ledger = fixture(), replay = factory.prepareChatPlanReplay(ledger), active = { id: replay.replayCaseId, tool: "gpt-chat-image" } as any;
        const harness = factory.routeHarness(ledger, active, replay);
        const payload = { operationType: "inpaint", modelConfigId: "d5000000-0000-4000-8000-000000000002", prompt: replay.prompt, sourceUrls: ["/api/assets/reference/content"], parameters: { tool: "gpt-chat-image" } };
        const premature = requestRoute("/api/tasks", payload); await harness.handle(premature);
        expect(premature.result.aborts).toBe(1); expect(ledger.submitted).toBe(38);
        await harness.handle(requestRoute("/api/chat/responses", planningPayload()));
        const changed = requestRoute("/api/tasks", { ...payload, prompt: "Different plan" }); await harness.handle(changed);
        expect(changed.result.aborts).toBe(1); expect(ledger.submitted).toBe(38);
        const allowed = requestRoute("/api/tasks", payload); await harness.handle(allowed);
        expect(allowed.result.continues).toBe(1); expect(ledger.submitted).toBe(39);
        const duplicate = requestRoute("/api/tasks", payload); await harness.handle(duplicate);
        expect(duplicate.result.aborts).toBe(1); expect(ledger.submitted).toBe(39);
    });
});

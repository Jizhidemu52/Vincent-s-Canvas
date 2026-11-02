import { assertNoPromptRuleLeak, PromptOptimizationError } from "./prompt-safety";
import { parseStrictJson } from "./strict-json";
import {
    IMAGE_AGENT_PROFILES, IMAGE_AGENT_SYSTEM_PROMPT, IMAGE_AGENT_COMPARISON_GUIDANCE, CANVAS_AGENT_GUIDANCE,
    buildImageAgentTools, imageAgentContextSchema, imageAgentLookSchema, imageAgentTool, parseImageAgentEdit, requestsCanvasStructure,
    type ImageAgentProfile,
} from "./image-agent-profile";
import type { ChatCompletionInput, ChatCompletionResult, ResponseInput, ResponseTool } from "./routes/chat";

export const chatPromptProfiles = IMAGE_AGENT_PROFILES;
export type ChatPromptProfile = ImageAgentProfile;
export const CREATIVE_CHAT_SYSTEM_PROMPT = IMAGE_AGENT_SYSTEM_PROMPT;
export const CANVAS_ASSISTANT_SYSTEM_PROMPT = `${IMAGE_AGENT_SYSTEM_PROMPT}\n${CANVAS_AGENT_GUIDANCE}`;
type ProfileInput = {
    profile?: ChatPromptProfile; profileContext?: unknown; toolKey?: string;
    input: ResponseInput[]; tools: ResponseTool[]; toolChoice?: unknown;
    claude?: { stream?: boolean; thinking?: boolean; maxTokens?: number };
};
// Kept at the route boundary for callers; recipes are loaded only by image execution.
export type ChatProfileRuleLoader = (profile: ChatPromptProfile) => Promise<string>;

const record = { type: "object", additionalProperties: true };
const ids = { type: "array", items: { type: "string" } };
const nodeType = { type: "string", enum: ["text", "image", "config", "video", "audio"] };
const mode = { type: "string", enum: ["text", "image", "video", "audio"] };
const viewport = { type: "object", properties: { x: { type: "number" }, y: { type: "number" }, k: { type: "number" } }, required: ["x", "y", "k"], additionalProperties: false };
const generation = { prompt: { type: "string" }, mode, title: { type: "string" }, x: { type: "number" }, y: { type: "number" }, referenceNodeIds: ids, autoRun: { type: "boolean" } };
const structuralTools: ResponseTool[] = [
    imageAgentTool("canvas_create_node", "创建节点或占位素材。", { nodeType, title: { type: "string" }, x: { type: "number" }, y: { type: "number" }, width: { type: "number" }, height: { type: "number" }, metadata: record }, ["nodeType"]),
    imageAgentTool("canvas_create_text_node", "创建文本节点。", { text: { type: "string" }, title: { type: "string" }, x: { type: "number" }, y: { type: "number" } }, ["text"]),
    imageAgentTool("canvas_create_generation_flow", "搭建生成流程，未要求执行时autoRun=false。", generation, ["prompt"]),
    imageAgentTool("canvas_create_config_node", "创建生成配置节点，未要求执行时autoRun=false。", generation),
    imageAgentTool("canvas_update_node", "更新节点基础字段或metadata。", { id: { type: "string" }, patch: record, metadata: record }, ["id"]),
    imageAgentTool("canvas_update_node_text", "更新文本节点内容。", { id: { type: "string" }, text: { type: "string" }, title: { type: "string" } }, ["id", "text"]),
    imageAgentTool("canvas_move_nodes", "移动或排列节点。", { items: { type: "array", minItems: 1, items: { type: "object", properties: { id: { type: "string" }, x: { type: "number" }, y: { type: "number" }, dx: { type: "number" }, dy: { type: "number" } }, required: ["id"], additionalProperties: false } } }, ["items"]),
    imageAgentTool("canvas_resize_node", "调整节点尺寸。", { id: { type: "string" }, width: { type: "number" }, height: { type: "number" }, freeResize: { type: "boolean" } }, ["id", "width", "height"]),
    imageAgentTool("canvas_delete_nodes", "删除指定节点及相关连线，需要界面确认。", { ids }, ["ids"]),
    imageAgentTool("canvas_connect_nodes", "连接指定节点。", { connections: { type: "array", minItems: 1, items: { type: "object", properties: { fromNodeId: { type: "string" }, toNodeId: { type: "string" } }, required: ["fromNodeId", "toNodeId"], additionalProperties: false } } }, ["connections"]),
    imageAgentTool("canvas_select_nodes", "选择节点。", { ids }, ["ids"]),
    imageAgentTool("canvas_set_viewport", "调整画布视口。", { viewport }, ["viewport"]),
    imageAgentTool("canvas_run_generation", "执行用户指定的生成节点。", { nodeId: { type: "string" }, mode, prompt: { type: "string" } }, ["nodeId"]),
];

export function buildCreativeChatTools(allowInspection = true, allowImageCreation = true) {
    return buildImageAgentTools({ allowInspection, allowGeneration: allowImageCreation }).map(({ type, ...definition }) => ({ type, function: definition }));
}

function invalidProfile(message = "聊天场景上下文无效，请重新打开该对话后重试。"): never {
    throw new PromptOptimizationError("CHAT_PROFILE_INVALID", message, 400);
}

/** Server-owned rules, bounded data, and the actual latest user instruction at the tail. */
export async function prepareChatProfileInput<T extends ProfileInput>(request: T, _loadRules?: ChatProfileRuleLoader): Promise<{ input: Omit<T, "input" | "tools" | "toolChoice" | "claude"> & ChatCompletionInput; privateRules: string[] }> {
    if (!request.profile) return { input: request, privateRules: [] };
    if (!(chatPromptProfiles as readonly string[]).includes(request.profile)) invalidProfile();
    const canvas = request.profile === "canvas-assistant";
    if (request.toolKey !== (canvas ? "canvas-chat" : "gpt-chat")) invalidProfile("聊天规则与当前板块不匹配，未发送模型请求。");
    if (!request.profileContext || JSON.stringify(request.profileContext).length > 60_000) invalidProfile();
    const parsed = imageAgentContextSchema.safeParse(request.profileContext);
    if (!parsed.success) invalidProfile();
    const context = parsed.data;
    if (!canvas && (context.selectedNodes || context.settings)) invalidProfile();
    if (request.input.some(item => !item || typeof item !== "object" || Array.isArray(item))) invalidProfile();
    if (request.input.some(item => "role" in item && item.role === "system")) invalidProfile("此聊天场景的系统规则由服务端管理，不能由客户端提供。");
    const allowGeneration = Boolean(context.currentUserText.trim());
    const tools = buildImageAgentTools({ canvas, allowGeneration, allowInspection: context.stage === "plan" });
    if (canvas && requestsCanvasStructure(context.currentUserText)) tools.push(...structuralTools);
    const system = [canvas ? CANVAS_ASSISTANT_SYSTEM_PROMPT : CREATIVE_CHAT_SYSTEM_PROMPT,
        /比较|对比|差异|分析|compare|difference/i.test(context.currentUserText) ? IMAGE_AGENT_COMPARISON_GUIDANCE : "",
        allowGeneration ? "" : "本轮只有资料，没有文字处理要求。请阅读并自然回应，不生成。",
    ].filter(Boolean).join("\n");
    const privateRules = [system, JSON.stringify(tools)];
    const messages = request.input.map(item => safeProfileReplayInput(item, privateRules));
    const previewCount = messages.reduce((count, item) => count + ("role" in item && Array.isArray(item.content) ? item.content.filter(part => part.type === "input_image").length : 0), 0);
    if (previewCount > 5) invalidProfile("本轮最多提供 5 张图片预览，未发送模型请求。");
    // On tool continuations keep the assistant/tool-result pair contiguous.
    let lastUser = -1;
    for (let index = messages.length - 1; index >= 0; index--) {
        const item = messages[index]!;
        if (!("role" in item) || item.role !== "user") continue;
        const text = typeof item.content === "string" ? item.content : item.content.filter(part => part.type === "input_text").map(part => part.text).join("\n");
        if (text === context.currentUserText) { lastUser = index; break; }
    }
    if (lastUser < 0) invalidProfile("当前用户消息与上下文不一致，未发送模型请求。");
    if (context.stage === "plan" && lastUser !== messages.length - 1) invalidProfile("当前用户消息必须放在本轮资料之后，未发送模型请求。");
    if (!allowGeneration) messages[lastUser] = { role: "user", content: "本轮仅上传资料，没有文字处理要求。" };
    messages.splice(lastUser, 0, { role: "user", content: `当前图片工作集（任务资料）：\n${JSON.stringify(context)}` });
    return { privateRules, input: { ...request, privateProfile: true, tools, toolChoice: "auto", input: [{ role: "system", content: system }, ...messages] } };
}

function safeProfileReplayInput(item: ResponseInput, privateRules: readonly string[]): ResponseInput {
    if ("role" in item) {
        if (item.role !== "user" && item.role !== "assistant") invalidProfile();
        if (item.role === "assistant") assertProfileRuleSafety(item.content, privateRules);
        return item;
    }
    if (item.type === "claude_assistant") return { ...item, content: checkedClaudeReplay(item.content, privateRules) };
    if (item.type === "responses_assistant") return { ...item, output: checkedResponsesReplay(item.output, privateRules) };
    if (item.type === "function_call") {
        assertProfileRuleSafety(item, privateRules);
        assertProfileRuleSafety(parseStrictJson(item.arguments), privateRules);
        return item;
    }
    if (item.type === "function_call_output") return item;
    return invalidProfile();
}

function checkedClaudeReplay(blocks: Array<Record<string, unknown>>, rules: readonly string[]) {
    assertProfileRuleSafety(blocks, rules);
    if (blocks.some(block => block.type === "thinking" && typeof block.thinking === "string" && Boolean(block.thinking.trim()))) {
        throw new PromptOptimizationError("CHAT_PRIVATE_THINKING_UNSUPPORTED", "该模型返回了不能安全回放的明文思考，请管理员选择支持隐藏思考的模型。", 422);
    }
    return blocks.filter(block => ["text", "tool_use", "redacted_thinking", "thinking"].includes(String(block.type))).map(block => {
        if (block.type === "text") return { type: "text", text: block.text };
        if (block.type === "tool_use") return { type: "tool_use", id: block.id, name: block.name, input: block.input };
        if (block.type === "thinking") return { type: "thinking", thinking: "", signature: block.signature };
        return { type: "redacted_thinking", data: block.data };
    });
}

function checkedResponsesReplay(items: Array<Record<string, unknown>>, rules: readonly string[]) {
    assertProfileRuleSafety(items, rules);
    return items.map(item => {
        if (item.type === "function_call") return { type: "function_call", id: item.id, call_id: item.call_id, name: item.name, arguments: item.arguments };
        if (item.type === "message") {
            if (item.role !== undefined && item.role !== "assistant") invalidProfile();
            return { type: "message", id: item.id, role: "assistant", content: Array.isArray(item.content) ? item.content.flatMap<Record<string, unknown>>(part => {
                if (!part || typeof part !== "object") return [];
                if (part.type === "output_text" && typeof part.text === "string") return [{ type: "output_text", text: part.text }];
                if (part.type === "refusal" && typeof part.refusal === "string") return [{ type: "refusal", refusal: part.refusal }];
                return [];
            }) : [] };
        }
        if (item.type !== "reasoning") invalidProfile("对话工具回放格式不受支持，未继续请求模型。");
        return { type: "reasoning", ...(typeof item.id === "string" ? { id: item.id } : {}), ...(typeof item.encrypted_content === "string" ? { encrypted_content: item.encrypted_content } : {}), summary: [] };
    });
}

export function validateChatProfileOutput(result: ChatCompletionResult, privateRules: readonly string[]): ChatCompletionResult {
    if (!privateRules.length) return result;
    assertProfileRuleSafety(result, privateRules);
    if (result.toolCalls.filter(call => call.function.name === "edit_image").length > 1) throw new PromptOptimizationError("IMAGE_AGENT_MULTIPLE_TASKS", "本轮返回了多个图片任务，未提交任何图片生成。请一次处理一张图片。", 422);
    const allowed = new Set((JSON.parse(privateRules[1] || "[]") as ResponseTool[]).map(tool => tool.name));
    for (const call of result.toolCalls) {
        if (!allowed.has(call.function.name)) throw new PromptOptimizationError("IMAGE_AGENT_TOOL_INVALID", "本轮返回了未开放的操作，未提交执行。", 422);
        const args = parseStrictJson(call.function.arguments);
        assertProfileRuleSafety(args, privateRules);
        if (call.function.name === "edit_image") parseImageAgentEdit(args);
        if (call.function.name === "look_at_images" && !imageAgentLookSchema.safeParse(args).success) throw new PromptOptimizationError("IMAGE_AGENT_ARGUMENTS_INVALID", "查看图片参数无效，未执行操作。", 422);
    }
    return { ...result,
        ...(result.claudeAssistantContent ? { claudeAssistantContent: checkedClaudeReplay(result.claudeAssistantContent, privateRules) } : {}),
        ...(result.responsesOutputItems ? { responsesOutputItems: checkedResponsesReplay(result.responsesOutputItems, privateRules) } : {}),
    };
}

export function assertProfileRuleSafety(value: unknown, privateRules: readonly string[]) {
    assertNoPromptRuleLeak(value, privateRules);
    assertNoPromptRuleLeak(value, privateRules.slice(0, 2), { strictEnglish: true });
}

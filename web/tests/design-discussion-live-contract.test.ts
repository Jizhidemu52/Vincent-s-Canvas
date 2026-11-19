import { describe, expect, test } from "bun:test";
import { designSessionRequest, readDesignSessionResult, requestDesignSession } from "../src/components/canvas/design-discussion/design-session.mjs";
import { createApi } from "../src/services/api/design-discussion.mjs";
import { createProposalExecution } from "../src/components/canvas/design-discussion/proposal-execution.mjs";
import fixture from "./fixtures/design-discussion-live-c7.json";
import executionFixture from "./fixtures/design-discussion-live-c14.json";

const preview = "data:image/png;base64,c291cmNl";
const reference = { id: "image-1795118572240-dzi4c", title: "knit-source.webp", role: "base", image: preview };
const referenceSnapshot = [{ id: reference.id, title: reference.title, role: "base", label: "图1" }];
const history = fixture.history.map(message => ({ ...message, referenceSnapshot }));
const options = { mode: "propose", prompt: fixture.prompt, history, proposalCount: 6, references: [reference], previews: [preview] };
const response = (value: unknown) => ({ content: JSON.stringify(value), toolCalls: [], stopReason: "stop" });
const clarification = {
    message: "当前最后明确要求是焦糖棕衣身、整段浅奶油色袖口，领口和下摆随衣身；此前细边、暗奶油与全同色仅是助手建议。保持这些锁定项无法形成六个实质不同方案。",
    questions: [{ id: "scope", question: "要保留当前完整版本只整理一个方案，还是由你指定可变范围后再做六个？", options: ["保留全部锁定项，改为一个方案", "保留当前配色，另行指定可变范围"] }],
    proposals: [], sources: [], trendStatus: "未实时检索",
};

describe("live design discussion proposal contract", () => {
    test("C14 selected execution keeps all thirteen captured user turns without stale discussion-only timing", () => {
        const input = {
            proposal: executionFixture.proposal, references: [reference],
            userRequirements: executionFixture.requirements.map(text => ({ text, referenceSnapshot })),
            generationAllowed: true, serverImageExecution: true,
        };
        expect(() => createProposalExecution({ ...input, generationAllowed: false })).toThrow("明确点击");
        expect(createProposalExecution({ ...input, userRequirements: input.userRequirements.slice(-1) }).generationAllowed).toBe(true);
        const execution = createProposalExecution(input);
        expect(execution.generationAllowed).toBe(true);
        expect(execution.proposal.requirementEvidence).toHaveLength(13);
        expect(execution.proposal.requirementEvidence.map((requirement: { originalText: string }) => requirement.originalText)).toEqual(executionFixture.requirements);
        expect(execution.userText).not.toContain("也不要生成");
        expect(execution.userText).not.toContain("这一步只给方案");
        expect(execution.userText).toContain("不加文字、Logo、口袋或配饰");
        expect(execution.userText).toContain("衣身和所有罗纹统一改成烟粉棕");
        expect(execution.userText).toContain("焦糖棕只留在历史里");
        expect(execution.sourcePrompt).toBe(executionFixture.proposal.prompt);
        expect(execution.baseId).toBe(reference.id);
        expect(execution.references.map((item: { id: string }) => item.id)).toEqual([reference.id]);
    });

    test("the captured C7 response remains rejected as three of six, not silently repaired", () => {
        expect(JSON.parse(fixture.response.content).proposals).toHaveLength(3);
        expect(() => readDesignSessionResult(fixture.response, options)).toThrow("方案数量不完整");
    });

    test("the request keeps user evidence separate from unaccepted assistant suggestions", () => {
        const request = designSessionRequest(options);
        const contractMessage = request.input.at(-2);
        expect(contractMessage.role).toBe("user");
        expect(typeof contractMessage.content).toBe("string");
        const contract = JSON.parse(contractMessage.content.slice(contractMessage.content.indexOf("\n") + 1));
        expect(contract.userEvidence).toHaveLength(6);
        expect(contract.userEvidence.map((message: { content: string }) => message.content.slice(message.content.indexOf("历史消息原文：\n") + "历史消息原文：\n".length))).toEqual(fixture.history.filter(message => message.role === "user").map(message => message.content));
        expect(contract.userEvidence.every((message: { role: string }) => message.role === "user")).toBe(true);
        expect(contract.userEvidence.at(-1).content).toContain("只让袖口罗纹改成浅奶油色，领口和下摆仍跟衣身");
        expect(JSON.stringify(contract.userEvidence)).not.toContain("0.5–1cm");
        expect(JSON.stringify(contract.userEvidence)).not.toContain("暗奶油色");
        expect(contract.currentUserText).toBe(fixture.prompt);
        expect(request.input.at(-1)).toEqual({ role: "user", content: fixture.prompt });
    });

    test.each([1, 6])("the final response contract carries the selected count %i without generation authority", proposalCount => {
        const request = designSessionRequest({ ...options, proposalCount });
        const contractMessage = request.input.at(-2).content;
        expect(typeof contractMessage).toBe("string");
        const contract = JSON.parse(contractMessage.slice(contractMessage.indexOf("\n") + 1));
        expect(contract.responseContract).toEqual({ proposalCount, alternatives: ["exact_proposals", "necessary_questions_only"], generationAllowed: false });
        expect(request.tools).toEqual([]);
        expect(request.toolChoice).toBe("none");
    });

    test("a later explicit user adoption is retained as user evidence without adopting sibling suggestions", () => {
        const adoption = "采纳细边建议，袖口只做0.5cm浅奶油色细边，不采用暗奶油或全同色。";
        const request = designSessionRequest({ ...options, history: [...history, { role: "user", content: adoption, referenceSnapshot }] });
        const content = request.input.at(-2).content;
        const contract = JSON.parse(content.slice(content.indexOf("\n") + 1));
        expect(contract.userEvidence).toHaveLength(7);
        expect(contract.userEvidence.at(-1).content).toContain(adoption);
        expect(contract.userEvidence.every((message: { role: string }) => message.role === "user")).toBe(true);
    });

    test("ordinary discussion may still answer without proposals or a forced clarification", () => {
        const request = designSessionRequest({ ...options, mode: "discuss" });
        const content = request.input.at(-2).content;
        const contract = JSON.parse(content.slice(content.indexOf("\n") + 1));
        expect(contract.responseContract.alternatives).toContain("discussion_only");
        expect(readDesignSessionResult(response({ ...clarification, questions: [] }), { ...options, mode: "discuss" }).proposals).toEqual([]);
    });

    test("thirteen rounds retain the first user locks and chronological replacements outside the recent context window", () => {
        const later = Array.from({ length: 7 }, (_, index) => [
            { role: "user", content: `第${index + 7}轮只继续讨论，其他要求不变。`, referenceSnapshot },
            { role: "assistant", content: `第${index + 7}轮未采纳的新建议。`, referenceSnapshot },
        ]).flat();
        const request = designSessionRequest({ ...options, history: [...history, ...later] });
        const content = request.input.at(-2).content;
        const contract = JSON.parse(content.slice(content.indexOf("\n") + 1));
        expect(contract.userEvidence).toHaveLength(13);
        expect(contract.userEvidence[0].content).toContain("锁定原圆领、轮廓、袖长和针织纹理；保持白底单件正面，不加文字、Logo、口袋或配饰");
        expect(contract.userEvidence[3].content).toContain("只保留暮砂，取消晨雾和浅冰蓝。再更新暮砂的主色为焦糖棕，浅沙色也作废");
        expect(contract.userEvidence[5].content).toContain("只让袖口罗纹改成浅奶油色，领口和下摆仍跟衣身");
        expect(contract.userEvidence.at(-1).content).toContain("第13轮只继续讨论");
        expect(contract.userEvidence.every((message: { role: string }) => message.role === "user")).toBe(true);
        expect(request.input.filter((message: { role: string }) => message.role === "assistant")).toHaveLength(8);
        expect(request.input.slice(1, -2).some((message: { content: unknown }) => typeof message.content === "string" && message.content.includes(history[0].content))).toBe(false);
    });

    test.each([true, false])("early user reference provenance survives a current reference change (same asset=%s)", retainAsset => {
        const other = { id: "new-color-reference", title: "color.png", role: "color", image: preview };
        const later = Array.from({ length: 12 }, (_, index) => [
            { role: "user", content: `第${index + 2}轮继续讨论。`, referenceSnapshot },
            { role: "assistant", content: "尚未采纳的建议。", referenceSnapshot },
        ]).flat();
        const references = retainAsset ? [other, reference] : [other];
        const request = designSessionRequest({ ...options, history: [history[0], history[1], ...later], references, previews: references.map(() => preview) });
        const content = request.input.at(-2).content;
        const contract = JSON.parse(content.slice(content.indexOf("\n") + 1));
        expect(contract.userEvidence).toHaveLength(13);
        const first = contract.userEvidence[0];
        expect(first.role).toBe("user");
        expect(first.content).toContain(history[0].content);
        expect(JSON.parse(first.content.split("\n")[1])).toEqual([{ id: reference.id, title: "knit-source.webp", role: "base", label: "图1", currentLabel: retainAsset ? "图2" : null }]);
    });

    test("over-budget early user evidence is rejected before any request instead of being dropped", async () => {
        const early = Array.from({ length: 6 }, (_, index) => ({ role: "user", content: `早期第${index + 1}项必须保留：${"原始要求".repeat(3600)}`, referenceSnapshot: [] }));
        const recent = Array.from({ length: 8 }, () => [{ role: "user", content: "继续讨论。", referenceSnapshot: [] }, { role: "assistant", content: "仅是建议。", referenceSnapshot: [] }]).flat();
        const calls: string[] = [];
        const api = createApi(async (path: string) => { calls.push(path); throw new Error(`Unexpected request: ${path}`); }, { projectId: "history-budget" });
        const input = { ...options, references: [], previews: [], history: [...early, ...recent] };
        expect(() => designSessionRequest(input)).toThrow("对话记录过长");
        await expect(requestDesignSession(api, "history-owner", input)).rejects.toThrow("对话记录过长");
        expect(calls).toEqual([]);
        expect(input.history).toHaveLength(22);
        expect(input.history[0].content).toContain("早期第1项必须保留");
    });

    test("an early user message still obeys message and image-snapshot validation after leaving the recent window", () => {
        const recent = Array.from({ length: 16 }, () => ({ role: "assistant", content: "后续讨论。", referenceSnapshot }));
        expect(() => designSessionRequest({ ...options, history: [{ role: "user", content: "锁".repeat(16001), referenceSnapshot }, ...recent] })).toThrow("历史消息无效或超出长度限制");
        expect(() => designSessionRequest({ ...options, history: [{ role: "user", content: "保留图1颜色。", referenceSnapshot: [{ ...referenceSnapshot[0], label: "图9" }] }, ...recent] })).toThrow("历史图号无效");
    });

    test("zero proposals plus a necessary scope clarification is displayable in propose mode", () => {
        const result = readDesignSessionResult(response(clarification), options);
        expect(result.proposals).toEqual([]);
        expect(result.questions).toEqual(clarification.questions);
        expect(() => readDesignSessionResult(response({ ...clarification, proposals: JSON.parse(fixture.response.content).proposals }), options)).toThrow("同时返回");
        expect(() => readDesignSessionResult(response({ ...clarification, questions: [] }), options)).toThrow("未返回方案或必要问题");
    });

    test("a full six-proposal response keeps the existing strict count contract", () => {
        const proposals = ["冰蓝", "浅沙", "焦糖", "米白", "黑", "灰"].map((color, index) => ({ id: `p${index}`, title: `${color}方案`, features: [`${color}衣身`, "圆领套头"], rationale: "自由配色探索。", prompt: `绘制一件${color}圆领套头毛衣。`, referenceIds: [], sourceNotes: [] }));
        const result = readDesignSessionResult(response({ message: "六个配色方向。", questions: [], proposals, sources: [], trendStatus: "未实时检索" }), { prompt: "自由探索六个不同配色", mode: "propose", proposalCount: 6, references: [] });
        expect(result.proposals).toHaveLength(6);
        expect(() => readDesignSessionResult(response({ message: "六个配色方向。", questions: [], proposals, sources: [], trendStatus: "未实时检索" }), { prompt: "自由探索三个不同配色", mode: "propose", proposalCount: 3, references: [] })).toThrow("方案数量无效");
    });

    test.each(["clarification", "incomplete"])("%s makes one chat request, no automatic retry and no image task", async kind => {
        const calls: Array<{ path: string; options?: RequestInit }> = [];
        const ownerId = "live-contract-owner";
        const incomplete = { ...clarification, questions: [], proposals: [1, 2, 3].map(index => ({ id: `p${index}`, title: `方案${index}`, features: ["焦糖棕衣身", "浅奶油袖口"], rationale: "本地结构回执。", prompt: "焦糖棕衣身，浅奶油袖口。", referenceIds: [], sourceNotes: [] })) };
        const api = createApi(async (path: string, request?: RequestInit) => {
            calls.push({ path, options: request });
            if (path === "/api/auth/session") return Response.json({ code: 0, data: { user: { id: ownerId, status: "active" } }, msg: "ok" });
            if (path === "/api/chat/responses") return Response.json({ code: 0, data: response(kind === "clarification" ? clarification : incomplete), msg: "ok" });
            throw new Error(`Unexpected request: ${path}`);
        }, { projectId: "live-contract-canvas" });
        const result = requestDesignSession(api, ownerId, { ...options, references: [] });
        if (kind === "clarification") expect((await result).questions).toEqual(clarification.questions);
        else await expect(result).rejects.toThrow("方案数量不完整");
        expect(calls.filter(call => call.options?.method === "POST").map(call => call.path)).toEqual(["/api/chat/responses"]);
        expect(calls.some(call => call.path.startsWith("/api/tasks") || call.path.startsWith("/api/assets") || call.path.startsWith("/api/image-conversations"))).toBe(false);
    });
});

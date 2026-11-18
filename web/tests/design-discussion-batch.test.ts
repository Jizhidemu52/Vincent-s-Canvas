import { describe, expect, test } from "bun:test";
import { createApi, createTaskController } from "../src/services/api/design-discussion.mjs";
import { generationSlots, requestedGenerationCount } from "../src/components/canvas/design-discussion/generation-batch.mjs";
import { createProposalExecution } from "../src/components/canvas/design-discussion/proposal-execution.mjs";

const ownerId = "designer-current";
const projectId = "canvas-current";
const reference = { id: "reference-a", title: "蓝灰针织原图", image: "/api/assets/11111111-1111-4111-8111-111111111111/content", role: "base" };
const imageModel = { id: "image-config", modelId: "public-image-model", name: "豆包生图", imageParameterProfile: "seedream55", capabilities: ["generate", "edit"] };
const videoModel = { id: "video-config", modelId: "public-video-model", parameterModelId: "seedance-2-5-flash", name: "视频模型", capabilities: ["video"] };
const catalog = { models: [imageModel, videoModel], tools: [{ toolKey: "image", enabled: true }, { toolKey: "image-edit", enabled: true }, { toolKey: "canvas-video", enabled: true, modelConfigId: videoModel.id }] };
const proposal = { id: "proposal-a", title: "蓝灰色方向", features: ["蓝灰配色", "保留针织纹理"], rationale: "依据用户指定颜色深化。", prompt: "创作蓝灰色平面花卉图案。", referenceIds: [], sourceNotes: [] };
type RecordData = Record<string, any>;
type RequestCall = { path: string; method: string; body?: RecordData };

function memoryStorage(initial: RecordData[] = []) {
    const records = new Map(initial.map(record => [record.id, structuredClone(record)]));
    return {
        records,
        async setItem(key: string, value: RecordData) { records.set(key, structuredClone(value)); },
        async iterate(visitor: (value: RecordData) => void) { for (const value of records.values()) visitor(structuredClone(value)); },
    };
}

function fixture(options: { loseReceipt?: boolean; queryMissing?: boolean; storage?: ReturnType<typeof memoryStorage>; sessionOwner?: () => string; catalog?: RecordData } = {}) {
    const calls: RequestCall[] = [];
    const receipts = new Map<string, RecordData>();
    const storage = options.storage || memoryStorage();
    let snapshot: RecordData[] = [];
    const fetcher = async (path: string, init?: RequestInit) => {
        const method = init?.method || "GET";
        const body = init?.body ? JSON.parse(String(init.body)) : undefined;
        calls.push({ path, method, body });
        if (path === "/api/auth/session") return Response.json({ user: { id: options.sessionOwner?.() || ownerId, status: "active" } });
        if (path === "/api/models") return Response.json(options.catalog || catalog);
        if (path === "/api/tasks" && method === "POST") {
            expect(storage.records.get(body.requestId)).toMatchObject({ requestId: body.requestId, ownerId, projectId, status: "submitting" });
            const receipt = { id: `server-${receipts.size + 1}`, requestId: body.requestId, userId: ownerId, projectId: body.projectId, status: "processing", resultUrls: [] };
            receipts.set(body.requestId, receipt);
            if (options.loseReceipt) throw new TypeError("fixture lost POST response");
            return Response.json({ code: 0, data: { task: receipt }, msg: "ok" });
        }
        if (path.startsWith("/api/tasks/by-request/")) {
            const receipt = receipts.get(decodeURIComponent(path.slice("/api/tasks/by-request/".length)));
            return options.queryMissing || !receipt ? Response.json({ message: "missing" }, { status: 404 }) : Response.json({ task: receipt });
        }
        if (path.startsWith("/api/tasks/") && method === "GET") {
            const receipt = [...receipts.values()].find(task => path === `/api/tasks/${task.id}`);
            return receipt ? Response.json({ task: receipt }) : Response.json({ message: "missing" }, { status: 404 });
        }
        throw new Error(`Unexpected fixture request: ${method} ${path}`);
    };
    const api = createApi(fetcher, { projectId });
    const controller = createTaskController({ api, storage, ownerId, projectId, onChange: (tasks: RecordData[]) => { snapshot = tasks; } });
    return { api, controller, storage, calls, receipts, tasks: () => snapshot, posts: () => calls.filter(call => call.path === "/api/tasks" && call.method === "POST") };
}

function generationInput(overrides: RecordData = {}) {
    return { generationAllowed: true, prompt: "创作蓝灰色平面花卉图案。", references: [], modelId: imageModel.id, proposal: { id: "proposal-a:output:0", originalId: proposal.id, batchId: "batch-a", outputIndex: 0 }, ...overrides };
}

describe("independent design generation slots", () => {
    test("discussion linkage persists with the original task and survives reloading", async () => {
        const run = fixture();
        const task = await run.controller.start(generationInput({ discussionSessionId: "discussion-a", discussionMessageId: "reply-a" }));
        expect(run.storage.records.get(task.id)).toMatchObject({ discussionSessionId: "discussion-a", discussionMessageId: "reply-a" });
        const restored = fixture({ storage: run.storage });
        await restored.controller.load();
        expect(restored.tasks()[0]).toMatchObject({ discussionSessionId: "discussion-a", discussionMessageId: "reply-a" });
        expect(restored.posts()).toHaveLength(0);
    });
    test.each(["生成3张", "给我三张图", "出3张图片"])("recognizes %s as three independent results", text => {
        expect(requestedGenerationCount(text)).toBe(3);
    });

    test("one selected proposal produces three stable, distinct slot keys", () => {
        const slots = generationSlots([proposal], [proposal.id], 3);
        expect(slots.map(slot => slot.key)).toEqual(["proposal-a:output:0", "proposal-a:output:1", "proposal-a:output:2"]);
        expect(slots.map(slot => slot.index)).toEqual([0, 1, 2]);
        expect(slots.every(slot => slot.proposal.id === proposal.id)).toBe(true);
        expect(generationSlots([proposal], [proposal.id, proposal.id], 3)).toEqual(slots);
    });

    test.each([3, 5, 15])("keeps %i independent outputs separate from the selected image composition", count => {
        const requirement = `给我六个可选方案，蓝灰、米驼、绿色各有区别，生成${count}张独立图片。`;
        const plan = createProposalExecution({ proposal, references: [], userRequirements: [{ text: requirement }], modelId: imageModel.id, generationAllowed: true });
        expect(generationSlots([proposal], [proposal.id], count)).toHaveLength(count);
        expect(plan.proposal.requirementEvidence[0].originalText).toBe(requirement);
        expect(plan.prompt).toContain(`当前独立任务只执行已选方案「${proposal.title}」`);
        expect(plan.prompt).toContain("独立生成次数由应用拆单处理，不是当前画面中的产品数量");
        expect(plan.prompt).toContain("用户明确指定的单张构图、多视图或排版仍须保留");
        expect(plan.prompt.endsWith(`本任务唯一选定的执行方案：\n${proposal.prompt}`)).toBe(true);
    });

    test("rejects invalid counts and missing selected proposals before submission", () => {
        for (const count of [0, 16, 1.5]) expect(() => generationSlots([proposal], [proposal.id], count)).toThrow("1–15");
        expect(() => generationSlots([proposal], ["missing"], 3)).toThrow("已失效");
        expect(() => generationSlots([proposal], [], 3)).toThrow("选中方案");
        expect(() => requestedGenerationCount("生成16张图")).toThrow("1–15");
    });

    test("submits three selected slots once each, each with count one and an independent request ID", async () => {
        const run = fixture();
        const plan = createProposalExecution({ proposal, references: [], userRequirements: [{ text: "先讨论、暂不出图、不提完整方案。创作蓝灰色平面花卉图案。" }], modelId: imageModel.id, generationAllowed: true });
        expect(plan.userText).toBe("创作蓝灰色平面花卉图案。");
        expect(plan.proposal.requirementEvidence[0].originalText).toContain("暂不出图、不提完整方案");
        const inputs = generationSlots([proposal], [proposal.id], 3).map(slot => ({ ...plan, proposal: { ...plan.proposal, id: slot.key, originalId: proposal.id, batchId: "batch-a", outputIndex: slot.index } }));
        const first = [];
        for (const input of inputs) first.push(await run.controller.start(input));
        for (let index = 0; index < inputs.length; index++) expect((await run.controller.start(inputs[index])).id).toBe(first[index].id);
        expect(run.posts()).toHaveLength(3);
        expect(new Set(run.posts().map(call => call.body?.requestId)).size).toBe(3);
        expect(run.posts().map(call => call.body?.projectId)).toEqual([projectId, projectId, projectId]);
        expect(run.posts().map(call => call.body?.parameters)).toEqual(Array.from({ length: 3 }, () => ({ size: "auto", resolution: "1k", n: 1, count: 1 })));
        expect(run.tasks().map(task => task.proposal.id)).toEqual(inputs.map(input => input.proposal.id));
        expect(run.calls.some(call => call.path === "/api/chat/responses")).toBe(false);
    });

    test("reloading a saved batch reuses its slot and never creates another POST", async () => {
        const run = fixture();
        const first = await run.controller.start(generationInput());
        const reload = fixture({ storage: run.storage });
        await reload.controller.load();
        const existing = await reload.controller.start(generationInput());
        expect(existing.id).toBe(first.id);
        expect(existing.requestId).toBe(first.requestId);
        expect(reload.posts()).toHaveLength(0);
        expect(reload.calls.some(call => call.path === "/api/models")).toBe(false);
        expect(reload.tasks()).toHaveLength(1);
    });

    test("the same slot in an explicitly new batch creates a new request", async () => {
        const run = fixture();
        const first = await run.controller.start(generationInput());
        const second = await run.controller.start(generationInput({ proposal: { id: "proposal-a:output:0", batchId: "batch-b" } }));
        expect(first.requestId).not.toBe(second.requestId);
        expect(run.posts()).toHaveLength(2);
    });

    test("a lost POST receipt queries the original request instead of resubmitting", async () => {
        const run = fixture({ loseReceipt: true });
        const task = await run.controller.start(generationInput());
        expect(task.status).toBe("processing");
        expect(task.taskId).toBe("server-1");
        expect(run.posts()).toHaveLength(1);
        expect(run.calls.filter(call => call.path.startsWith("/api/tasks/by-request/"))).toEqual([{ path: `/api/tasks/by-request/${task.requestId}`, method: "GET", body: undefined }]);
        await run.controller.refreshAll();
        expect((await run.controller.start(generationInput())).requestId).toBe(task.requestId);
        expect(run.posts()).toHaveLength(1);
    });

    test("a missing recovery query stays uncertain through refresh and another batch click", async () => {
        const run = fixture({ loseReceipt: true, queryMissing: true });
        const task = await run.controller.start(generationInput());
        expect(task.status).toBe("uncertain");
        await run.controller.refreshAll();
        expect((await run.controller.start(generationInput())).requestId).toBe(task.requestId);
        expect(run.tasks()[0]).toMatchObject({ status: "uncertain", requestId: task.requestId });
        expect(run.posts()).toHaveLength(1);
        expect(run.calls.filter(call => call.path.startsWith("/api/tasks/by-request/")).every(call => call.method === "GET" && call.path.endsWith(task.requestId))).toBe(true);
    });

    test("a concurrent duplicate start is rejected while the first operation is pending", async () => {
        let releaseSession: (() => void) | undefined;
        const sessionGate = new Promise<void>(resolve => { releaseSession = resolve; });
        const run = fixture();
        const api = { ...run.api, session: async () => { await sessionGate; return { user: { id: ownerId, status: "active" } }; } };
        const controller = createTaskController({ api, storage: run.storage, ownerId, projectId, onChange: () => {} });
        const first = controller.start(generationInput());
        await expect(controller.start(generationInput())).rejects.toThrow("请勿重复操作");
        releaseSession?.();
        await first;
        expect(run.posts()).toHaveLength(1);
    });

    test("persistence failure or owner change prevents any generation POST", async () => {
        const storage = memoryStorage();
        storage.setItem = async () => { throw new Error("fixture storage unavailable"); };
        const persistence = fixture({ storage });
        await expect(persistence.controller.start(generationInput())).rejects.toThrow("storage unavailable");
        expect(persistence.posts()).toHaveLength(0);
        let checks = 0;
        const changedOwner = fixture({ sessionOwner: () => ++checks === 1 ? ownerId : "another-designer" });
        await expect(changedOwner.controller.start(generationInput())).rejects.toThrow("登录身份已变化");
        expect(changedOwner.posts()).toHaveLength(0);
    });

    test("load excludes another owner and another canvas and never repeats a submitting record", async () => {
        const stored = { id: "request-restored", requestId: "request-restored", ownerId, projectId, startedAt: 1, status: "submitting", proposal: generationInput().proposal };
        const run = fixture({ storage: memoryStorage([stored, { ...stored, id: "other-canvas", projectId: "foreign-canvas" }, { ...stored, id: "other-owner", ownerId: "foreign-owner" }]) });
        await run.controller.load();
        expect(run.tasks()).toHaveLength(1);
        expect(run.tasks()[0]).toMatchObject({ id: stored.id, status: "uncertain" });
        expect((await run.controller.start(generationInput())).id).toBe(stored.id);
        await run.controller.refreshAll();
        expect(run.posts()).toHaveLength(0);
        expect(run.calls.some(call => call.path === `/api/tasks/by-request/${stored.requestId}`)).toBe(true);
    });
});

describe("design discussion video generation", () => {
    test("a camera plan cannot drop the garment counts before the Flash task is submitted", async () => {
        const run = fixture();
        const userText = "图1是唯一服装。生成6秒视频。保持棕米配色、立领、门襟四颗按扣、两个斜口袋各一颗按扣、肩片、矩形袖片及针织纹理不变。全程衣服完整。";
        const input = { references: [reference], userRequirements: [{ text: userText, referenceSnapshot: [{ id: reference.id, title: reference.title, role: "base", label: "图1" }] }], modelId: videoModel.id, outputKind: "video", generationAllowed: true };
        const incomplete = { ...proposal, referenceIds: [reference.id], prompt: "图1一件完整棕米色针织衫，镜头6秒缓慢推近，保持衣服完整，无旋转。" };
        expect(() => createProposalExecution({ ...input, proposal: incomplete })).toThrow("遗漏可确定的数量");
        expect(run.posts()).toHaveLength(0);
        const complete = { ...incomplete, prompt: "图1作为唯一首帧，生成6秒完整针织衫视频。镜头只极轻微推近。保持棕米配色、立领、门襟四颗按扣、两个斜口袋各一颗按扣、肩片、矩形袖片及针织纹理不变。全程一件衣服完整入镜，不裁切、不旋转、不出现人物文字或新物体。" };
        const plan = createProposalExecution({ ...input, proposal: complete });
        await run.controller.start({ ...plan, videoSeconds: 6 });
        expect(run.posts()).toHaveLength(1);
        expect(run.posts()[0].body).toMatchObject({ toolKey: "canvas-video", modelConfigId: videoModel.id, parameters: { seconds: 6, resolution: "720p", videoMode: "first-frame" } });
        expect(run.posts()[0].body?.prompt).toContain("门襟四颗按扣、两个斜口袋各一颗按扣");
    });

    test.each([
        { references: [], mode: "text" },
        { references: [reference], mode: "first-frame" },
        { references: [reference, { ...reference, id: "reference-b", title: "颜色参考" }], mode: "reference" },
    ])("uses the configured video parameter model for $mode", async variant => {
        const run = fixture();
        const task = await run.controller.start(generationInput({ mediaKind: "video", references: variant.references, modelId: videoModel.id, videoSeconds: 8 }));
        expect(task.mediaKind).toBe("video");
        expect(run.posts()).toHaveLength(1);
        expect(run.posts()[0].body).toMatchObject({ projectId, toolKey: "canvas-video", operationType: "video_generation", modelConfigId: videoModel.id, sourceUrls: variant.references.map(ref => ref.image), parameters: { videoMode: variant.mode, seconds: 8, size: "adaptive", resolution: "720p", generateAudio: false, watermark: false, outputFormat: "mp4" } });
        expect(run.posts()[0].body?.parameters.count).toBeUndefined();
        expect(run.posts()[0].body?.parameters.n).toBeUndefined();
        expect(run.calls.some(call => call.path.includes("upload"))).toBe(false);
    });

    test("a video proposal retains video output kind through validated execution", async () => {
        const videoProposal = { ...proposal, prompt: "蓝灰色针织服装缓慢转动展示，镜头平稳。" };
        const plan = createProposalExecution({ proposal: videoProposal, references: [], userRequirements: [{ text: "展示蓝灰色针织服装，镜头平稳。" }], modelId: videoModel.id, outputKind: "video", generationAllowed: true });
        expect(plan.mediaKind).toBe("video");
        const run = fixture();
        await run.controller.start({ ...plan, videoSeconds: 6 });
        expect(run.posts()[0].body).toMatchObject({ toolKey: "canvas-video", operationType: "video_generation", parameters: { seconds: 6 } });
    });

    test("disabled or differently bound video tools stop before POST", async () => {
        for (const tool of [{ toolKey: "canvas-video", enabled: false }, { toolKey: "canvas-video", enabled: true, modelConfigId: "different-model" }]) {
            const run = fixture({ catalog: { ...catalog, tools: [tool] } });
            await expect(run.controller.start(generationInput({ mediaKind: "video", modelId: videoModel.id }))).rejects.toThrow("模型、描述或参考图已失效");
            expect(run.posts()).toHaveLength(0);
        }
    });
});

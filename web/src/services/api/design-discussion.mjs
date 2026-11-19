import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex } from "@noble/hashes/utils";
import { createClientUuid } from "../../lib/client-uuid.ts";
import { availableModels, imageParameters, mergeServerTask, ownedAsset } from "../../components/canvas/design-discussion/task-model.mjs";
import { normalizeFeedback, validateDesignRecord } from "../../components/canvas/design-discussion/design-record.mjs";
import { designVideoModels } from "../../components/canvas/design-discussion/model-presets.mjs";
import { isImageAgentPlanningIssue } from "../../../../shared/image-agent-iteration.ts";
import { createImageConversationApi } from "./image-conversations";
import { createDesignConversationController } from "./design-discussion-conversations";

export function createApi(fetcher = globalThis.fetch.bind(globalThis), { projectId = "canvas-island-demo" } = {}) {
    async function request(path, options = {}) {
        const response = await fetcher(path, { credentials: "same-origin", signal: AbortSignal.timeout(20000), ...options });
        const body = await response.json().catch(() => null);
        if (!response.ok) {
            const error = new Error(body?.message || body?.msg || body?.error || `接口返回 ${response.status}`);
            error.status = response.status;
            const issue = { code: body?.error, message: error.message, repairable: body?.repairable, submitted: body?.submitted };
            if (response.status === 422 && isImageAgentPlanningIssue(issue)) error.planningIssue = issue;
            throw error;
        }
        return body?.data ?? body;
    }
    const json = (body, ownerId) => ({ method: "POST", headers: { "Content-Type": "application/json", "x-canvas-owner-id": ownerId }, body: JSON.stringify(body) });
    return {
        session: () => request("/api/auth/session"),
        catalog: () => request("/api/models"),
        health: () => request("/api/health"),
        assets: query => request(`/api/assets?${new URLSearchParams({ kind: "image", limit: "24", ...query })}`),
        assistant: (body, ownerId) => request("/api/chat/responses", { ...json(body, ownerId), signal: AbortSignal.timeout(180000) }),
        async upload(reference, ownerId) {
            if (ownedAsset(reference.image)) return { id: reference.id, title: reference.title, image: reference.image };
            const localBlob = typeof location !== "undefined" && reference.image.startsWith(`blob:${location.origin}/`);
            if (!localBlob && !/^data:image\/(png|jpeg|webp);base64,/.test(reference.image) && !/^\/design-examples\/[\w-]+\.(?:webp|png)$/.test(reference.image)) throw new Error("参考图来源不受支持，请重新上传图片。");
            const response = await fetcher(reference.image);
            if (!response.ok) throw new Error("参考图读取失败，尚未提交生成。");
            const blob = await response.blob();
            if (!/^image\/(png|jpeg|webp)$/.test(blob.type) || !blob.size || blob.size > 8 * 1024 * 1024) throw new Error("参考图须为 8 MB 内的 PNG、JPG 或 WebP。");
            const contentSha256 = bytesToHex(sha256(new Uint8Array(await blob.arrayBuffer())));
            const upload = await request("/api/assets/upload-request", json({ filename: reference.title, mimeType: blob.type, byteSize: blob.size, metadata: { contentSha256 }, clientReferenceId: createClientUuid() }, ownerId));
            const image = `/api/assets/${upload.assetId}/content`;
            if (!ownedAsset(image)) throw new Error("服务器返回了无效的素材编号。");
            if (upload.uploadUrl) {
                if (!new RegExp(`^/api/assets/${upload.assetId}/(?:content-upload|upload)(?:\\?repair=1)?$`, "i").test(upload.uploadUrl)) throw new Error("服务器上传地址不受支持。");
                const saved = await fetcher(upload.uploadUrl, { method: "PUT", headers: { "Content-Type": blob.type, "x-canvas-owner-id": ownerId }, body: blob, signal: AbortSignal.timeout(30000) });
                if (!saved.ok) throw new Error("参考图上传失败，尚未提交生成。");
            }
            return { id: reference.id, title: reference.title, image };
        },
        async query(task) {
            try { return (await request(task.taskId ? `/api/tasks/${encodeURIComponent(task.taskId)}` : `/api/tasks/by-request/${encodeURIComponent(task.requestId)}`)).task; }
            catch (error) { if (error.status === 404) return null; throw error; }
        },
        async submit(task, ownerId) {
            const video = task.mediaKind === "video";
            const body = { requestId: task.requestId, projectId, toolKey: video ? "canvas-video" : task.references.length ? "image-edit" : "image", operationType: video ? "video_generation" : task.references.length ? "inpaint" : "image_generation", modelConfigId: task.modelId, prompt: task.prompt, sourceUrls: task.references.map(ref => ref.image), parameters: task.parameters };
            return (await request("/api/tasks", json(body, ownerId))).task;
        },
        async recover(task, ownerId) {
            return (await request(`/api/tasks/${encodeURIComponent(task.taskId)}/recover`, json({}, ownerId))).task;
        },
    };
}

export function createTaskController({ api, storage, ownerId, projectId = "canvas-island-demo", onChange, imageConversationsEnabled = false, conversationApi, assertWritable }) {
    if (!imageConversationsEnabled) return createLegacyTaskController({ api, storage, ownerId, projectId, onChange });
    let legacyTasks = [], imageTasks = [];
    const emit = () => onChange([...legacyTasks, ...imageTasks].sort((left, right) => left.startedAt - right.startedAt));
    const legacy = createLegacyTaskController({ api, storage, ownerId, projectId, onChange: value => { legacyTasks = value; emit(); } });
    const images = createDesignConversationController({ api: conversationApi || createImageConversationApi(ownerId), storage, ownerId, canvasExternalId: projectId, assertWritable,
        uploadReference: reference => api.upload(reference, ownerId), assertOwner: async () => {
            const identity = await api.session();
            if (identity?.user?.id !== ownerId || identity.user.status !== "active") throw Object.assign(new Error("登录身份已变化，请刷新页面后再操作。"), { code: "SESSION_CHANGED" });
        }, onChange: value => { imageTasks = value; emit(); } });
    return {
        async load() { await legacy.load(); await images.load(); },
        start: input => input.mediaKind === "video" ? legacy.start(input) : images.start(input),
        async refreshAll() { await legacy.refreshAll(); await images.refreshAll(); },
        action: (id, action) => images.has(id) ? images.action(id, action) : legacy.action(id, action),
        saveReview: (id, review) => images.has(id) ? images.saveReview(id, review) : legacy.saveReview(id, review),
        saveFeedback: (id, feedback) => images.has(id) ? images.saveFeedback(id, normalizeFeedback(feedback)) : legacy.saveFeedback(id, feedback),
        dispose: () => images.dispose(),
    };
}

function createLegacyTaskController({ api, storage, ownerId, projectId = "canvas-island-demo", onChange }) {
    let tasks = [];
    let starting = false;
    let polling = false;
    let annotationTime = 0;
    const inFlight = new Set();
    const receipts = new Map();
    const annotations = new Map();
    const emit = () => onChange([...tasks]);
    async function checkOwner() {
        const session = await api.session();
        if (session?.user?.id !== ownerId || session.user.status !== "active") throw Object.assign(new Error("登录身份已变化，请刷新页面后再操作。"), { code: "SESSION_CHANGED" });
    }
    function withAnnotations(task) {
        const receipt = receipts.get(task.id) || task;
        const entries = [...annotations.values()].filter(entry => entry.taskId === task.id && entry.requestId === task.requestId)
            .sort((a, b) => a.recordedAt.localeCompare(b.recordedAt) || a.id.localeCompare(b.id));
        const feedback = entries.filter(entry => entry.type === "feedback").map(entry => entry.value);
        const reviews = entries.filter(entry => entry.type === "review");
        return { ...task, feedback: feedback.at(-1) || receipt.feedback, feedbackHistory: [...(receipt.feedbackHistory || []), ...feedback], review: reviews.at(-1)?.value || receipt.review };
    }
    function publish(task) {
        const current = withAnnotations(task);
        tasks = tasks.some(item => item.id === task.id) ? tasks.map(item => item.id === task.id ? current : item) : [...tasks, current];
        emit();
        return current;
    }
    function collectAnnotation(entry) {
        if (entry?.kind !== "task-annotation" || entry.ownerId !== ownerId || !["feedback", "review"].includes(entry.type)) return;
        annotations.set(entry.id, entry);
        annotationTime = Math.max(annotationTime, Date.parse(entry.recordedAt) || 0);
    }
    async function refreshAnnotations() {
        await storage.iterate(collectAnnotation);
        tasks = tasks.map(withAnnotations);
        emit();
    }
    async function save(task, required = false) {
        const receipt = receipts.get(task.id) || task;
        const stored = { ...task, feedback: receipt.feedback, feedbackHistory: receipt.feedbackHistory, review: receipt.review, persistenceError: "" };
        try {
            await storage.setItem(task.id, stored);
            receipts.set(task.id, stored);
            return publish(stored);
        } catch (error) {
            if (required) throw error;
            return publish({ ...task, persistenceError: error.message || "本地存储暂不可用" });
        }
    }
    async function appendAnnotation(task, type, value) {
        annotationTime = Math.max(Date.now(), annotationTime + 1);
        const recordedAt = new Date(annotationTime).toISOString();
        const id = `annotation:${createClientUuid()}`;
        const entry = { id, kind: "task-annotation", ownerId, taskId: task.id, requestId: task.requestId, type, recordedAt, value: type === "feedback" ? { ...value, recordedAt } : value };
        await storage.setItem(id, entry);
        collectAnnotation(entry);
        publish(tasks.find(item => item.id === task.id) || task);
    }
    async function refresh(id, recover = false) {
        const current = tasks.find(task => task.id === id);
        if (!current || inFlight.has(id)) return;
        inFlight.add(id);
        try {
            const task = recover ? await api.recover(current, ownerId) : await api.query(current);
            const latest = tasks.find(item => item.id === id);
            await save(task ? mergeServerTask(latest, task, ownerId) : { ...latest, queryError: "暂未查到原任务，不会自动重新提交。" });
        } catch (error) {
            await save({ ...tasks.find(item => item.id === id), queryError: error.message });
        } finally { inFlight.delete(id); }
    }
    return {
        async load() {
            const records = [];
            receipts.clear(); annotations.clear();
            await storage.iterate(task => {
                if (task?.ownerId !== ownerId || (task.projectId && task.projectId !== projectId)) return;
                if (task.kind === "image-conversation-execution") return;
                if (task.kind === "task-annotation") { collectAnnotation(task); return; }
                if (typeof task.id !== "string" || typeof task.requestId !== "string") return;
                receipts.set(task.id, task);
                records.push(task.status === "preparing" ? { ...task, status: "failed", failureReason: "准备过程已中断，尚未提交模型。" } : task.status === "submitting" ? { ...task, status: "uncertain" } : task);
            });
            tasks = records.sort((a, b) => a.startedAt - b.startedAt).map(withAnnotations);
            emit();
        },
        async start(input) {
            if (input.generationAllowed !== true) throw new Error("本轮没有明确的生成操作，没有提交生成。");
            if (starting) throw new Error("正在提交，请勿重复操作。");
            starting = true;
            let id;
            try {
                await checkOwner();
                if (input.proposal?.batchId && input.proposal?.id) {
                    const existing = tasks.find(task => task.proposal?.batchId === input.proposal.batchId && task.proposal?.id === input.proposal.id);
                    if (existing) return existing;
                }
                const catalog = await api.catalog();
                const video = input.mediaKind === "video";
                const model = (video ? designVideoModels(catalog) : availableModels(catalog, input.references.length)).find(item => item.id === input.modelId);
                if (!model || !input.prompt.trim() || input.references.length > 4) throw new Error("模型、描述或参考图已失效，请检查后再提交。");
                if (input.designRecord) validateDesignRecord(input.designRecord);
                let parameters;
                if (video) {
                    const { videoModelRequestParameters, videoReferenceError, resolveVideoMode } = await import("../../lib/video-model-parameters.ts");
                    const config = { model: model.modelId, videoModel: model.modelId, videoMode: input.references.length === 1 ? "first-frame" : input.references.length ? "reference" : "text", size: "adaptive", vquality: "720p", videoSeconds: String(input.videoSeconds || 6), videoGenerateAudio: "false", videoWatermark: "false", videoSeed: "", videoOutputFormat: "mp4" };
                    const parameterModel = model.parameterModelId ?? model.modelId;
                    const issue = videoReferenceError(config, input.references, [], [], undefined, false, parameterModel);
                    if (issue) throw new Error(issue);
                    const mode = resolveVideoMode(config, input.references.length, 0, 0, undefined, parameterModel);
                    parameters = videoModelRequestParameters({ ...config, videoMode: mode }, parameterModel, mode);
                } else parameters = imageParameters(model, input.references.length);
                if (input.requestId && !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.requestId)) throw new Error("生成请求编号无效，尚未提交。");
                id = input.requestId || createClientUuid();
                const recorded = tasks.find(task => task.requestId === id);
                if (recorded) return recorded;
                let task = { id, requestId: id, ownerId, projectId, mediaKind: video ? "video" : "image", prompt: input.prompt.trim(), userText: input.userText || input.prompt.trim(), references: input.references, modelId: model.id, model: model.name, parameters, status: "preparing", startedAt: Date.now(), observing: true, resultUrls: [], baseId: input.baseId, keep: input.keep || [], spec: input.spec, workNote: input.workNote || "", conversation: input.conversation || [], brief: input.brief || {}, designRecord: input.designRecord, executionContract: input.executionContract, feedback: { status: "unreviewed", note: "" }, feedbackHistory: [], caseIds: input.caseIds || [] };
                if (input.proposal) task.proposal = structuredClone(input.proposal);
                if (input.discussionSessionId) task.discussionSessionId = input.discussionSessionId;
                if (input.discussionMessageId) task.discussionMessageId = input.discussionMessageId;
                await save(task, true);
                inFlight.add(id);
                try {
                    const references = [];
                    for (const reference of input.references) references.push({ ...await api.upload(reference, ownerId), kind: reference.kind || "reference", workNote: reference.workNote || "", keep: reference.keep || [], role: reference.role || "auto", ...(reference.parentId ? { parentId: reference.parentId } : {}), ...(reference.taskId ? { taskId: reference.taskId } : {}) });
                    await checkOwner();
                    task = { ...task, references, status: "submitting" };
                    await save(task, true);
                } catch (error) {
                    if (error.code === "SESSION_CHANGED") throw error;
                    return await save({ ...task, status: "failed", failureReason: `${error.message}；尚未提交模型。` });
                }
                try { task = mergeServerTask(task, await api.submit(task, ownerId), ownerId); }
                catch (error) {
                    task = { ...task, status: [400, 401, 403, 404, 413, 422].includes(error.status) ? "failed" : "uncertain", failureReason: error.message };
                    try {
                        const found = await api.query(task);
                        if (found) task = mergeServerTask(task, found, ownerId);
                    } catch (queryError) { task = { ...task, queryError: queryError.message }; }
                }
                return await save(task);
            } finally { starting = false; if (id) inFlight.delete(id); }
        },
        async refreshAll() {
            if (polling || starting) return;
            polling = true;
            try {
                await checkOwner();
                await refreshAnnotations();
                for (const task of tasks) if (task.observing !== false && (task.persistenceError || ["submitting", "uncertain", "waiting", "processing"].includes(task.status))) await refresh(task.id);
            } finally { polling = false; }
        },
        async action(id, action) {
            const task = tasks.find(item => item.id === id);
            if (!task || inFlight.has(id)) return;
            if (action === "stop") return save({ ...task, observing: false });
            await checkOwner();
            await save({ ...task, observing: true });
            const recover = action === "recover" && task.status === "paused" && Boolean(task.upstreamTaskId) && Boolean(task.taskId);
            await refresh(id, recover);
        },
        async saveReview(id, review) {
            await checkOwner();
            const task = tasks.find(item => item.id === id);
            if (task?.status === "success") await appendAnnotation(task, "review", review);
        },
        async saveFeedback(id, value) {
            await checkOwner();
            const task = tasks.find(item => item.id === id);
            if (task?.status !== "success" || !task.resultUrls?.length) throw new Error("只有实际生成结果可以记录反馈。");
            const feedback = normalizeFeedback(value);
            await appendAnnotation(task, "feedback", feedback);
        },
    };
}

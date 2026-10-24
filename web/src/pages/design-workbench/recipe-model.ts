import type { AiConfig } from "@/stores/use-config-store";
import type { ReferenceImage } from "@/types/image";
import type { requestEdit } from "@/services/api/image";
import type { QueuedTask } from "@/services/api/generation-tasks";
import { createClientUuid } from "@/lib/client-uuid";

export type RecipeColor = { name: string; hex: string };
export type RecipeForm = {
    kind: "structure" | "pattern";
    series: string;
    constraints: string;
    prompt: string;
    count: number;
    palette: RecipeColor[];
    paletteStyle: "soft" | "vivid" | "earth" | "free";
    positions: string[];
};
export type RecipeSettings = Pick<AiConfig, "model" | "imageModel" | "size" | "quality" | "count" | "imageOptions">;
export type RecipeBranchStatus = "waiting" | "running" | "success" | "failed" | "uncertain" | "cancelled";
export type RecipeBranch = {
    id: string;
    index: number;
    prompt: string;
    status: RecipeBranchStatus;
    attempts: number;
    requestId?: string;
    taskIds: string[];
    submissionStarted: boolean;
    images: ReferenceImage[];
    error: string;
    selected: boolean;
    optimizing?: boolean;
    optimized?: boolean;
};
export type RecipeRun = { id: string; ownerId: string; createdAt: string; form: RecipeForm; references: ReferenceImage[]; settings: RecipeSettings; branches: RecipeBranch[] };
export type RecipeProject = { version: 1; kind: "series-recipe"; ownerId: string; form: RecipeForm; references: ReferenceImage[]; settings: RecipeSettings; run?: RecipeRun };
export type RecipeDependencies = {
    generate: typeof requestEdit;
    query: (taskIds: string[], requestId: string, signal: AbortSignal) => Promise<QueuedTask | null>;
    isCurrent: () => boolean;
    onChange: (run: RecipeRun, active: boolean, paused: boolean) => Promise<void>;
    createId?: () => string;
};

const copy = <T>(value: T): T => structuredClone(value);
const message = (error: unknown) => (error instanceof Error ? error.message : "操作失败");
export const recipeStatusLabels: Record<RecipeBranchStatus, string> = { waiting: "等待提交", running: "生成中", success: "已完成", failed: "已确认失败", uncertain: "待核查原任务", cancelled: "已停止" };
export function createRecipeForm(): RecipeForm {
    return {
        kind: "structure",
        series: "我的新系列",
        constraints: "保持参考款的廓形、裁片、缝线、辅料和背景不变",
        prompt: "同一款式的协调配色系列，保留真实面料纹理和光影。",
        count: 1,
        palette: [
            { name: "雾青", hex: "#91a8a1" },
            { name: "沙杏", hex: "#cfb799" },
            { name: "陶粉", hex: "#b9827b" },
            { name: "鼠尾草", hex: "#9da882" },
            { name: "暮蓝", hex: "#8295ad" },
            { name: "烟紫", hex: "#a19aae" },
        ],
        paletteStyle: "soft",
        positions: ["前身居中，中等尺寸", "左胸，小尺寸", "前身下摆，横向布局", "右侧偏置，中等尺寸", "领口下方，小尺寸", "前身大幅布局，保留边缘留白"],
    };
}

/** Only non-secret image settings belong in a portable/local project. */
export function recipeSettings(config: Partial<AiConfig>): RecipeSettings {
    return { model: String(config.model || ""), imageModel: String(config.imageModel || config.model || ""), size: String(config.size || "auto"), quality: String(config.quality || "auto"), count: "1", imageOptions: String(config.imageOptions || "") };
}

export function recipePromptInput(form: RecipeForm, index: number, hasMotif: boolean): import("../../../../shared/prompt-contracts").PromptInputData {
    return { scene: "series-recipe", fields: { ...copy(form), variantIndex: index, hasMotif }, userText: form.prompt,
        referenceRoles: ["产品底图", ...(hasMotif ? ["图案参考图"] : [])], mode: "edit" };
}

export function createRecipeRun(ownerId: string, form: RecipeForm, references: ReferenceImage[], config: Partial<AiConfig>): RecipeRun {
    if (!references[0]) throw new Error("请先上传参考底图");
    const frozenForm = { ...copy(form), count: 1 },
        frozenRefs = copy(form.kind === "pattern" ? references : references.slice(0, 1));
    return {
        id: createClientUuid(),
        ownerId,
        createdAt: new Date().toISOString(),
        form: frozenForm,
        references: frozenRefs,
        settings: recipeSettings(config),
        branches: Array.from({ length: 1 }, (_, index) => ({
            id: `variant-${index + 1}`,
            index,
            prompt: frozenForm.prompt,
            status: "waiting",
            attempts: 0,
            taskIds: [],
            submissionStarted: false,
            images: [],
            error: "",
            selected: false,
        })),
    };
}

/** Sequential real requests: pause affects scheduling, never the provider's accepted job. */
export class SeriesRecipeRunner {
    private run: RecipeRun;
    private controller = new AbortController();
    private wake?: () => void;
    private disposed = false;
    active = false;
    paused = false;
    constructor(
        run: RecipeRun,
        private config: AiConfig,
        private deps: RecipeDependencies,
    ) {
        this.run = copy(run);
    }
    snapshot() {
        return copy(this.run);
    }
    private current() {
        return !this.disposed && this.deps.isCurrent();
    }
    private async emit() {
        if (this.current()) await this.deps.onChange(this.snapshot(), this.active, this.paused);
    }
    pause() {
        if (this.active) {
            this.paused = true;
            void this.emit().catch(() => this.cancel());
        }
    }
    resume() {
        this.paused = false;
        this.wake?.();
        this.wake = undefined;
        void this.emit().catch(() => this.cancel());
    }
    cancel() {
        this.paused = false;
        this.controller.abort();
        this.wake?.();
        this.wake = undefined;
    }
    dispose() {
        this.disposed = true;
        this.cancel();
    }
    async start(mode: "waiting" | "failed" = "waiting") {
        if (this.active || !this.current()) return;
        this.controller = new AbortController();
        this.active = true;
        this.paused = false;
        try {
            await this.emit();
            for (const branch of this.run.branches) {
                if (branch.status !== mode) continue;
                if (this.paused)
                    await new Promise<void>((resolve) => {
                        this.wake = resolve;
                    });
                if (this.controller.signal.aborted || !this.current()) break;
                branch.status = "running";
                branch.error = "";
                branch.attempts++;
                branch.requestId = this.deps.createId?.() || createClientUuid();
                branch.taskIds = [];
                branch.submissionStarted = false;
                try {
                    await this.emit();
                    if (!this.current()) break;
                    this.controller.signal.throwIfAborted();
                    const outputs = await this.deps.generate({ ...this.config, ...this.run.settings, count: "1" }, branch.prompt, this.run.references, undefined, {
                        tool: "series-recipe",
                        promptInput: recipePromptInput(this.run.form, branch.index, this.run.references.length > 1),
                        onOptimizing: () => { branch.optimizing = true; void this.emit(); },
                        onCompiled: (prompt, optimized) => { branch.prompt = prompt; branch.optimized = optimized; branch.optimizing = false; void this.emit(); },
                        operationType: "inpaint",
                        requestId: branch.requestId,
                        signal: this.controller.signal,
                        // Stopping this page stops polling, not an already billed upstream task.
                        cancelOnAbort: () => false,
                        onSubmissionStarted: async () => {
                            if (!this.current()) throw new Error("员工会话已变化");
                            branch.submissionStarted = true;
                            await this.emit();
                            if (!this.current()) throw new Error("员工会话已变化");
                        },
                        onSubmitted: async (ids) => {
                            if (this.current()) {
                                branch.taskIds = ids;
                                await this.emit();
                            }
                        },
                    });
                    if (!this.current()) break;
                    if (!outputs.length) throw new Error("任务未返回图片，请查询原任务");
                    branch.images = outputs.map((output, index) => ({ id: output.id, dataUrl: output.dataUrl, name: `候选 ${branch.index + 1}-${index + 1}`, type: "image/png" }));
                    branch.status = "success";
                    branch.optimizing = false;
                    branch.selected = true;
                } catch (error) {
                    if (!this.current()) break;
                    const task = (error as { task?: QueuedTask })?.task;
                    branch.status = (error as { submissionRejected?: boolean })?.submissionRejected ? "failed" : task?.status === "failed" ? "failed" : task?.status === "cancelled" ? "cancelled" : branch.submissionStarted || branch.taskIds.length ? "uncertain" : this.controller.signal.aborted ? "cancelled" : "failed";
                    branch.error = message(error);
                    branch.optimizing = false;
                }
                await this.emit();
                // Old imported projects may contain multiple waiting branches. Each
                // explicit start/retry schedules at most one; other branches stay intact.
                break;
            }
        } finally {
            if (this.controller.signal.aborted)
                this.run.branches.forEach((branch) => {
                    if (branch.status === "waiting") branch.status = "cancelled";
                });
            this.active = false;
            this.paused = false;
            await this.emit();
        }
    }
    /** Read-only recovery. No POST, no fresh requestId, no extra billed generation. */
    async recover() {
        if (this.active || !this.current()) return;
        this.active = true;
        this.controller = new AbortController();
        try {
            await this.emit();
            for (const branch of this.run.branches) {
                if (branch.status !== "uncertain" || !branch.requestId || !this.current() || this.controller.signal.aborted) continue;
                try {
                    const task = await this.deps.query(branch.taskIds, branch.requestId, this.controller.signal);
                    if (!this.current()) break;
                    if (task?.prompt) { branch.prompt = task.prompt; branch.optimized = task.optimized; }
                    if (!task) {
                        branch.error = "暂未查到原任务，仍保留请求标识；请稍后核查，不要重复提交。";
                    } else {
                        branch.taskIds = [task.id];
                        if (task.status === "success" && task.resultUrls.length) {
                            branch.images = task.resultUrls.map((dataUrl, index) => ({ id: `${task.id}-${index}`, name: `候选 ${branch.index + 1}-${index + 1}`, type: "image/png", dataUrl }));
                            branch.status = "success";
                            branch.selected = true;
                            branch.error = "";
                        } else if (task.status === "failed" || task.status === "cancelled") {
                            branch.status = task.status;
                            branch.error = task.failureReason || "原任务已结束";
                        } else branch.error = task.failureReason || "原任务仍在处理或已暂停；不会重复生成。";
                    }
                } catch (error) {
                    if (this.current()) branch.error = message(error);
                }
                await this.emit();
            }
        } finally {
            this.active = false;
            this.paused = false;
            await this.emit();
        }
    }
}

function record(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("项目格式无效");
    return value as Record<string, unknown>;
}
const string = (value: unknown, max: number, fallback = "") => (typeof value === "string" ? value.slice(0, max) : fallback);
function parseForm(value: unknown): RecipeForm {
    const input = record(value),
        defaults = createRecipeForm();
    if (!Number.isInteger(input.count) || Number(input.count) < 1 || Number(input.count) > 6) throw new Error("候选数量应为 1–6");
    const palette = input.palette;
    if (!Array.isArray(palette) || palette.length !== 6) throw new Error("配色数据应包含六个颜色");
    const colors = palette.map((item) => {
        const color = record(item);
        if (!/^#[\da-f]{6}$/i.test(String(color.hex))) throw new Error("配色色值无效");
        return { name: string(color.name, 40, "自选色"), hex: String(color.hex).toLowerCase() };
    });
    return {
        kind: input.kind === "pattern" ? "pattern" : "structure",
        series: string(input.series, 80),
        constraints: string(input.constraints, 2000),
        prompt: string(input.prompt, 3000),
        count: Number(input.count),
        palette: colors,
        paletteStyle: ["soft", "vivid", "earth", "free"].includes(String(input.paletteStyle)) ? (input.paletteStyle as RecipeForm["paletteStyle"]) : "soft",
        positions: defaults.positions.map((fallback, index) => string(Array.isArray(input.positions) ? input.positions[index] : undefined, 160, fallback)),
    };
}
function parseImages(value: unknown, portable: boolean): ReferenceImage[] {
    if (!Array.isArray(value) || value.length > 6) throw new Error("项目图片数量无效");
    return value.map((item) => {
        const image = record(item),
            url = String(image.dataUrl || "");
        const embedded = /^data:image\/(png|jpeg|webp);base64,[A-Za-z\d+/=\s]+$/.test(url);
        if (!embedded && (portable || !/^\/api\/assets\/[\w-]+\/content(?:\?[^#]*)?$/.test(url))) throw new Error("项目必须包含 PNG/JPG/WebP 图片内容，不能引用外部链接");
        return { id: string(image.id, 100) || createClientUuid(), name: string(image.name, 200, "参考图"), type: embedded ? url.slice(5, url.indexOf(";")) : "image/png", dataUrl: url };
    });
}

export function parseRecipeProject(value: unknown, ownerId: string, portable = false): RecipeProject {
    const input = record(value);
    if (input.version !== 1 || input.kind !== "series-recipe") throw new Error("不是受支持的系列配方项目");
    if (!portable && input.ownerId !== ownerId) throw new Error("项目不属于当前员工");
    const project: RecipeProject = { version: 1, kind: "series-recipe", ownerId, form: { ...parseForm(input.form), count: 1 }, references: parseImages(input.references, portable), settings: recipeSettings(record(input.settings)) };
    if (project.references.length > 2) throw new Error("参考图最多两张");
    if (input.run) {
        const saved = record(input.run),
            form = parseForm(saved.form),
            sameOwner = saved.ownerId === ownerId;
        if (!Array.isArray(saved.branches) || saved.branches.length !== form.count) throw new Error("候选记录数量无效");
        const branches = saved.branches.map((item, index): RecipeBranch => {
            const branch = record(item);
            let status: RecipeBranchStatus = Object.hasOwn(recipeStatusLabels, String(branch.status)) ? (branch.status as RecipeBranchStatus) : "cancelled";
            const submissionStarted = branch.submissionStarted === true;
            if (status === "running") status = submissionStarted ? "uncertain" : "failed";
            if (!sameOwner && (status === "uncertain" || status === "waiting")) status = "cancelled";
            const images = parseImages(branch.images, portable);
            if (status === "success" && !images.length) throw new Error("已完成候选缺少图片");
            return {
                id: `variant-${index + 1}`,
                index,
                prompt: string(branch.prompt, 20000),
                optimized: branch.optimized === true,
                status,
                attempts: Number.isSafeInteger(branch.attempts) ? Math.max(0, Math.min(Number(branch.attempts), 9999)) : 0,
                requestId: sameOwner ? string(branch.requestId, 200) || undefined : undefined,
                taskIds: sameOwner && Array.isArray(branch.taskIds) ? branch.taskIds.filter((id): id is string => typeof id === "string" && /^[\w-]+$/.test(id)).slice(0, 1) : [],
                submissionStarted: sameOwner && submissionStarted,
                images,
                selected: status === "success" && branch.selected === true,
                error: !sameOwner && status === "cancelled" ? "原任务属于其他员工，无法在当前账号查询或继续" : string(branch.error, 1000),
            };
        });
        project.run = { id: string(saved.id, 100) || createClientUuid(), ownerId, createdAt: string(saved.createdAt, 40), form, references: parseImages(saved.references, portable), settings: recipeSettings(record(saved.settings)), branches };
        if (project.run.references.length > 2 || !project.run.references.length) throw new Error("原任务参考图缺失或数量无效");
    }
    return project;
}

const paletteCollections: Record<RecipeForm["paletteStyle"], string[][]> = {
    soft: [
        ["#91a8a1", "#cfb799", "#b9827b", "#9da882", "#8295ad", "#a19aae"],
        ["#b3c7ca", "#f0d6c5", "#bfb4d1", "#e6c2b9", "#cad4ba", "#d9ccab"],
        ["#b3becb", "#d7b9c0", "#c8c7b9", "#a5b7aa", "#dbcaad", "#a6b1c9"],
    ],
    vivid: [
        ["#ed605b", "#4662c2", "#edba3e", "#238773", "#9b53a7", "#eb8741"],
        ["#ec5987", "#237da5", "#cdc041", "#663da8", "#de6e30", "#2eab82"],
    ],
    earth: [
        ["#947657", "#b5a27d", "#727a57", "#b36e4f", "#544c43", "#d7c5a4"],
        ["#b58165", "#7a8676", "#c5b294", "#6d5650", "#9e8d67", "#d8bb9a"],
    ],
    free: [
        ["#59779a", "#d38c82", "#d8cf68", "#673e61", "#9ba482", "#dfb891"],
        ["#7d5067", "#508c8e", "#d8a144", "#a8c2d0", "#d87051", "#909b73"],
    ],
};
export function randomRecipePalette(style: RecipeForm["paletteStyle"], random = Math.random): RecipeColor[] {
    const choices = paletteCollections[style],
        palette = [...choices[Math.min(choices.length - 1, Math.floor(random() * choices.length))]!];
    for (let i = palette.length - 1; i > 0; i--) {
        const j = Math.max(0, Math.min(i, Math.floor(random() * (i + 1))));
        [palette[i], palette[j]] = [palette[j]!, palette[i]!];
    }
    return palette.map((hex, index) => ({ hex, name: `配色 ${index + 1}` }));
}

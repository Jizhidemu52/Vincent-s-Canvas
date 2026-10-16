import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { ArrowLeft, Download, ImagePlus, LoaderCircle, Palette, Pause, Play, RefreshCw, Save, Square, Upload, X } from "lucide-react";
import { saveAs } from "file-saver";
import { ImageSettingsPanel } from "@/components/image-settings-panel";
import { ModelPicker } from "@/components/model-picker";
import { useToolConfig, useToolEnabled } from "@/hooks/use-tool-config";
import { canvasThemes } from "@/lib/canvas-theme";
import { deploymentFeatures } from "@/lib/deployment-features";
import { validateImageReferences } from "@/lib/image-reference-policy";
import { useImageModelProfile } from "@/lib/image-model-settings";
import { readFileAsDataUrl } from "@/lib/image-utils";
import { createWorkspaceStorage } from "@/lib/workspace-storage";
import { requestEdit } from "@/services/api/image";
import { getQueuedTask, getQueuedTaskByRequestId } from "@/services/api/generation-tasks";
import { imageToDataUrl } from "@/services/image-storage";
import { modelOptionName, useEffectiveConfig } from "@/stores/use-config-store";
import { useBusinessConfigStore } from "@/stores/use-business-config-store";
import { isModuleAvailable, useModuleStore } from "@/stores/use-module-store";
import { useThemeStore } from "@/stores/use-theme-store";
import { useUserStore } from "@/stores/use-user-store";
import type { ReferenceImage } from "@/types/image";
import {
    buildRecipePrompt,
    createRecipeForm,
    createRecipeRun,
    parseRecipeProject,
    randomRecipePalette,
    recipeSettings,
    recipeStatusLabels,
    SeriesRecipeRunner,
    type RecipeForm,
    type RecipeProject,
    type RecipeRun,
    type RecipeSettings,
} from "./recipe-model";
import "./recipe.css";

const draftWrites = new Map<string, Promise<unknown>>();
const errorText = (error: unknown) => (error instanceof Error ? error.message : "操作未完成");
const cleanName = (name: string) => (name || "系列配方").replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-").slice(0, 80);

export default function RecipePage() {
    const ownerId = useUserStore((state) => state.user?.id);
    return ownerId ? (
        <RecipeWorkspace key={ownerId} ownerId={ownerId} />
    ) : (
        <main className="series-recipe-page">
            <h1>系列配方</h1>
            <p>正在确认当前员工身份，请从有效的登录会话进入。</p>
        </main>
    );
}

function RecipeWorkspace({ ownerId }: { ownerId: string }) {
    const effectiveConfig = useEffectiveConfig();
    const user = useUserStore((state) => state.user);
    const enabled = useToolEnabled("series-recipe");
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const business = useBusinessConfigStore();
    const [storage] = useState(() => createWorkspaceStorage("series_recipe_workspaces"));
    const scope = `project:${encodeURIComponent(ownerId)}`;
    const mounted = useRef(true);
    const runner = useRef<SeriesRecipeRunner | null>(null);
    const busy = useRef(false);
    const [project, setProject] = useState<RecipeProject>(() => ({ version: 1, kind: "series-recipe", ownerId, form: createRecipeForm(), references: [], settings: recipeSettings({ ...effectiveConfig, model: effectiveConfig.imageModel, count: "1" }) }));
    const projectRef = useRef(project);
    const [ready, setReady] = useState(false);
    const [active, setActive] = useState(false);
    const [paused, setPaused] = useState(false);
    const [recovering, setRecovering] = useState(false);
    const [working, setWorking] = useState(false);
    const [notice, setNotice] = useState("");
    const [error, setError] = useState("");
    const [preview, setPreview] = useState<ReferenceImage | null>(null);
    const [activeColor, setActiveColor] = useState(0);
    const [colorDraft, setColorDraft] = useState(project.form.palette[0]!.hex);
    const [paletteMode, setPaletteMode] = useState<"manual" | "random">("manual");
    const configInput = useMemo(() => ({ ...effectiveConfig, ...project.settings, count: "1", model: project.settings.imageModel || project.settings.model }), [effectiveConfig, project.settings]);
    const config = useToolConfig(configInput, "series-recipe");
    const profile = useImageModelProfile(config.model);
    const selectedModel = business.models.find((model) => model.id === config.model || model.modelId === modelOptionName(config.model) || model.name === config.model);
    const refs = project.form.kind === "pattern" ? project.references : project.references.slice(0, 1);
    const estimate = business.estimate({ toolKey: "series-recipe", operationType: "inpaint", modelId: modelOptionName(config.model), quantity: 1 });
    const refsValidation = validateImageReferences(modelOptionName(config.model), refs);
    const quotaBlocked = deploymentFeatures.creditsEnabled && !!user && estimate.configured && user.creditBalance < estimate.credits;
    const validation = !ready
        ? "正在读取本地项目"
        : !enabled
          ? "系列配方已被管理员停用，已有项目仍保留"
          : user?.status !== "active"
            ? "当前账号不可用"
            : business.status === "error"
              ? "模型配置加载失败，请重载配置"
              : business.status !== "ready"
                ? "正在加载模型配置"
                : !project.references[0]
                  ? "请先上传参考底图"
                  : !selectedModel?.capabilities.includes("edit") || !profile.requiresPrompt || ["midjourney", "midjourney-blend"].includes(profile.kind)
                    ? "请选择可理解指令的图像编辑模型"
                    : !refsValidation.valid
                      ? refsValidation.message
                      : quotaBlocked
                        ? "当前额度不足"
                        : "";
    const locked = active || working || !ready;
    const run = project.run;
    const branches = run?.branches || [];
    const succeeded = branches.filter((branch) => branch.status === "success").length;
    const failed = branches.filter((branch) => branch.status === "failed").length;
    const uncertain = branches.filter((branch) => branch.status === "uncertain").length;
    const waiting = branches.filter((branch) => branch.status === "waiting").length;
    const selected = branches.filter((branch) => branch.status === "success" && branch.selected);
    const completed = succeeded + failed + branches.filter((branch) => branch.status === "cancelled").length;
    const dirty = !!run && (JSON.stringify(run.form) !== JSON.stringify(project.form) || run.references[0]?.id !== project.references[0]?.id || JSON.stringify(run.settings) !== JSON.stringify(recipeSettings(config)));

    const current = useCallback(() => mounted.current && storage.isCurrent() && useUserStore.getState().user?.id === ownerId, [ownerId, storage]);
    const commit = useCallback(
        (next: RecipeProject) => {
            if (current()) {
                projectRef.current = next;
                setProject(next);
            }
        },
        [current],
    );
    const persist = useCallback(
        (next: RecipeProject) => {
            const frozen = structuredClone(next);
            const write = (draftWrites.get(scope) || Promise.resolve())
                .catch(() => undefined)
                .then(async () => {
                    if (!current()) return;
                    await storage.setItem(scope, frozen);
                });
            draftWrites.set(scope, write);
            void write
                .finally(() => {
                    if (draftWrites.get(scope) === write) draftWrites.delete(scope);
                })
                .catch(() => undefined);
            return write;
        },
        [scope, storage, current],
    );

    useEffect(() => {
        mounted.current = true;
        let alive = true;
        void (async () => {
            try {
                await draftWrites.get(scope);
                const saved = await storage.getItem<unknown>(scope);
                if (alive && current() && saved) {
                    commit(parseRecipeProject(saved, ownerId));
                    setNotice("已恢复当前员工的本地项目。未完成任务不会自动重发。");
                }
            } catch (caught) {
                if (alive && current()) setError(`本地项目读取失败：${errorText(caught)}`);
            } finally {
                if (alive && current()) setReady(true);
            }
        })();
        const unsubscribe = useUserStore.subscribe((state) => {
            if (state.user?.id !== ownerId) {
                runner.current?.dispose();
                mounted.current = false;
            }
        });
        const checkEnabled = () => {
            if (!isModuleAvailable(useModuleStore.getState().flags, useBusinessConfigStore.getState().tools, "series-recipe")) runner.current?.cancel();
        };
        const unsubscribeModules = useModuleStore.subscribe(checkEnabled);
        const unsubscribeConfig = useBusinessConfigStore.subscribe(checkEnabled);
        return () => {
            alive = false;
            mounted.current = false;
            runner.current?.dispose();
            unsubscribe();
            unsubscribeModules();
            unsubscribeConfig();
        };
    }, [scope, storage, ownerId, current, commit]);

    useEffect(() => {
        if (business.status === "idle") void business.refresh().catch(() => undefined);
    }, [business.status, business.refresh]);
    useEffect(() => {
        if (!ready || active) return;
        const timer = window.setTimeout(() => {
            void persist(project)
                .then(() => {
                    if (current()) setNotice("已自动保存到当前员工的浏览器；不等于云端备份。");
                })
                .catch((caught) => {
                    if (current()) setError(`自动保存失败：${errorText(caught)}`);
                });
        }, 450);
        return () => window.clearTimeout(timer);
    }, [project, ready, active, persist, current]);
    useEffect(() => {
        const index = Math.min(activeColor, project.form.count - 1);
        setActiveColor(index);
        setColorDraft(project.form.palette[index]!.hex);
    }, [project.form.palette, project.form.count, activeColor]);
    useEffect(() => {
        if (!preview) return;
        const dismiss = (event: KeyboardEvent) => {
            if (event.key === "Escape") setPreview(null);
        };
        window.addEventListener("keydown", dismiss);
        return () => window.removeEventListener("keydown", dismiss);
    }, [preview]);

    const updateForm = (patch: Partial<RecipeForm>) => {
        if (!busy.current && !runner.current?.active) commit({ ...projectRef.current, form: { ...projectRef.current.form, ...patch } });
    };
    const updateSettings = useCallback(
        (key: "quality" | "size" | "count" | "imageOptions" | "model" | "imageModel", value: string) => {
            if (busy.current || runner.current?.active || key === "count") return;
            const old = projectRef.current;
            if (old.settings[key] === value) return;
            const settings: RecipeSettings = key === "model" || key === "imageModel" ? { ...old.settings, model: value, imageModel: value } : { ...old.settings, [key]: value };
            commit({ ...old, settings });
        },
        [commit],
    );
    const action = async (work: () => Promise<void>) => {
        if (busy.current || runner.current?.active || !current()) return;
        busy.current = true;
        setWorking(true);
        setError("");
        try {
            await work();
        } catch (caught) {
            if (current()) setError(errorText(caught));
        } finally {
            busy.current = false;
            if (current()) setWorking(false);
        }
    };
    const upload = async (slot: number, file: File) =>
        action(async () => {
            if (!["image/png", "image/jpeg", "image/webp"].includes(file.type) || file.size > 15 * 1024 * 1024) throw new Error("请选择不超过 15 MB 的 PNG、JPG 或 WebP 图片");
            const dataUrl = await readFileAsDataUrl(file);
            await loadImage(dataUrl);
            if (!current()) return;
            const old = projectRef.current;
            if (slot === 1 && !old.references[0]) throw new Error("请先上传参考底图");
            const images = [...old.references];
            images[slot] = { id: crypto.randomUUID(), name: file.name, originalFileName: file.name, type: file.type, dataUrl };
            commit({ ...old, references: images });
            setNotice(`已读取 ${file.name}，原图不会被修改。`);
        });

    const makeRunner = (snapshot: RecipeRun) => {
        const instance: SeriesRecipeRunner = new SeriesRecipeRunner(
            snapshot,
            { ...config, ...snapshot.settings },
            {
                generate: requestEdit,
                isCurrent: () => current() && runner.current === instance,
                onChange: async (nextRun, running, isPaused) => {
                    if (!current() || runner.current !== instance) return;
                    const next = { ...projectRef.current, run: nextRun };
                    commit(next);
                    setActive(running);
                    setPaused(isPaused);
                    // Durably store the request id before onSubmissionStarted allows the POST.
                    await persist(next);
                },
                query: async (taskIds, requestId, signal) => {
                    let task = taskIds[0] ? await getQueuedTask(taskIds[0], signal) : await getQueuedTaskByRequestId(`${requestId}:0`, signal);
                    while (task && !["success", "failed", "cancelled", "paused"].includes(task.status)) {
                        if (!current()) throw new Error("员工会话已变化");
                        await pollDelay(signal);
                        task = await getQueuedTask(task.id, signal);
                    }
                    return task;
                },
            },
        );
        return instance;
    };
    const start = async (mode: "new" | "failed" | "waiting" | "recover") => {
        if (busy.current || runner.current?.active || !ready || !current()) return;
        if (!enabled || user?.status !== "active") {
            setError("当前账号或系列配方不可用");
            return;
        }
        if (mode === "new" && (validation || uncertain)) {
            setError(validation || "请先核查原任务，避免重复付费生成");
            return;
        }
        busy.current = true;
        setError("");
        setRecovering(mode === "recover");
        try {
            const snapshot = mode === "new" ? createRecipeRun(ownerId, projectRef.current.form, projectRef.current.references, config) : projectRef.current.run;
            if (!snapshot) return;
            runner.current?.dispose();
            const instance = makeRunner(snapshot);
            runner.current = instance;
            if (mode === "recover") await instance.recover();
            else await instance.start(mode === "failed" ? "failed" : "waiting");
        } catch (caught) {
            if (current()) setError(errorText(caught));
        } finally {
            busy.current = false;
            if (current()) {
                setActive(false);
                setPaused(false);
                setRecovering(false);
            }
        }
    };
    const portableProject = async () => {
        const output = structuredClone(projectRef.current);
        const embedded = async (image: ReferenceImage) => {
            if (!current()) throw new Error("员工会话已变化");
            const dataUrl = await imageToDataUrl(image);
            if (!current()) throw new Error("员工会话已变化");
            return { ...image, dataUrl, url: undefined, storageKey: undefined };
        };
        output.references = await Promise.all(output.references.map(embedded));
        if (output.run) {
            output.run.references = await Promise.all(output.run.references.map(embedded));
            for (const branch of output.run.branches) branch.images = await Promise.all(branch.images.map(embedded));
        }
        return output;
    };
    const exportProject = () =>
        action(async () => {
            const output = await portableProject();
            if (current()) {
                saveAs(new Blob([JSON.stringify(output, null, 2)], { type: "application/json" }), `${cleanName(output.form.series)}-系列配方.json`);
                setNotice("已导出完整项目，包含原图、候选、冻结指令与任务标识。文件包含设计资料，请妥善保管。");
            }
        });
    const importProject = (file: File) =>
        action(async () => {
            if (file.size > 250 * 1024 * 1024) throw new Error("项目文件超过 250 MB，请使用较小项目");
            const imported = parseRecipeProject(JSON.parse(await file.text()), ownerId, true);
            if (!current()) return;
            if (!window.confirm("导入会替换当前页面项目（不会删除服务端任务）。请先导出需要保留的方案。继续导入？")) return;
            runner.current?.dispose();
            runner.current = null;
            commit(imported);
            await persist(imported);
            setNotice("项目已导入。候选图片已保留，未完成任务不会自动重发。");
        });
    const exportBoard = () =>
        action(async () => {
            const source = projectRef.current.run;
            if (!source) return;
            const candidates = source.branches.filter((branch) => branch.selected && branch.status === "success");
            if (!candidates.length) throw new Error("请先选择候选");
            const images = await Promise.all(candidates.map(async (branch) => loadImage(await imageToDataUrl(branch.images[0]!))));
            if (!current()) return;
            const columns = Math.min(3, images.length),
                width = 1440,
                pad = 56,
                gap = 24,
                tile = (width - pad * 2 - gap * (columns - 1)) / columns;
            const imageHeight = 510,
                rowHeight = 600,
                height = 190 + Math.ceil(images.length / columns) * rowHeight;
            const canvas = document.createElement("canvas");
            canvas.width = width;
            canvas.height = height;
            const ctx = canvas.getContext("2d");
            if (!ctx) throw new Error("当前浏览器无法导出方案板");
            ctx.fillStyle = "#f5f3ee";
            ctx.fillRect(0, 0, width, height);
            ctx.fillStyle = "#262626";
            ctx.font = "bold 36px sans-serif";
            ctx.fillText(source.form.series || "系列方案", pad, 70, width - pad * 2);
            ctx.fillStyle = "#666666";
            ctx.font = "20px sans-serif";
            ctx.fillText("AI 生成候选 · 颜色仅为屏幕近似值，需实物打样确认", pad, 108);
            images.forEach((image, index) => {
                const x = pad + (index % columns) * (tile + gap),
                    y = 150 + Math.floor(index / columns) * rowHeight;
                ctx.fillStyle = "#ffffff";
                ctx.fillRect(x, y, tile, imageHeight);
                const scale = Math.min((tile - 20) / image.naturalWidth, (imageHeight - 20) / image.naturalHeight);
                ctx.drawImage(image, x + (tile - image.naturalWidth * scale) / 2, y + (imageHeight - image.naturalHeight * scale) / 2, image.naturalWidth * scale, image.naturalHeight * scale);
                const candidate = candidates[index]!,
                    color = source.form.palette[candidate.index]!;
                ctx.fillStyle = source.form.kind === "structure" ? color.hex : "#8a8a8a";
                ctx.fillRect(x, y + imageHeight + 22, 18, 18);
                ctx.fillStyle = "#333333";
                ctx.font = "20px sans-serif";
                ctx.fillText(`候选 ${candidate.index + 1} · ${source.form.kind === "structure" ? color.hex.toUpperCase() : source.form.positions[candidate.index]}`, x + 28, y + imageHeight + 39, tile - 28);
            });
            const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((value) => (value ? resolve(value) : reject(new Error("方案板导出失败"))), "image/png"));
            if (current()) {
                saveAs(blob, `${cleanName(source.form.series)}-方案板.png`);
                setNotice("已导出所选候选的 PNG 方案板。");
            }
        });
    const applyColor = () => {
        if (!/^#?[\da-f]{6}$/i.test(colorDraft)) {
            setError("请输入完整六位 HEX 色值，例如 #91A8A1");
            return;
        }
        const hex = `${colorDraft.startsWith("#") ? "" : "#"}${colorDraft}`.toLowerCase();
        updateForm({ palette: project.form.palette.map((color, index) => (index === activeColor ? { name: `自选色 ${index + 1}`, hex } : color)) });
        setError("");
    };

    return (
        <main className="series-recipe-page">
            <header className="sr-header">
                <div>
                    <Link to="/creative" className="sr-back">
                        <ArrowLeft size={15} />
                        创意设计
                    </Link>
                    <h1>系列配方</h1>
                    <p>一份参考，多条设计方向。逐分支真实生成，保留每一步的输入与结果。</p>
                </div>
                <span className="sr-badge">
                    <Palette size={15} />
                    系列设计工作台
                </span>
            </header>
            <div className="sr-workspace">
                <aside className="sr-panel sr-inputs" aria-label="系列配方设置">
                    <div className="sr-panel-heading">
                        <h2>01 / 设置配方</h2>
                        <span>输入与约束</span>
                    </div>
                    <fieldset disabled={locked} className="sr-fields">
                        <label className="sr-field">
                            选择流程
                            <select aria-label="选择流程" value={project.form.kind} onChange={(event) => updateForm({ kind: event.target.value as RecipeForm["kind"] })}>
                                <option value="structure">参考款 → 保留结构 → 系列配色</option>
                                <option value="pattern">产品与图案 → 定位 → 系列候选</option>
                            </select>
                        </label>
                        <RecipeUpload label="参考底图（必需）" image={project.references[0]} disabled={locked} onUpload={(file) => void upload(0, file)} onRemove={() => commit({ ...projectRef.current, references: [] })} />
                        {project.form.kind === "pattern" && (
                            <RecipeUpload
                                label="图案参考（可选）"
                                image={project.references[1]}
                                disabled={locked || !project.references[0]}
                                onUpload={(file) => void upload(1, file)}
                                onRemove={() => commit({ ...projectRef.current, references: projectRef.current.references.slice(0, 1) })}
                            />
                        )}
                        {project.form.kind === "pattern" && <p className="sr-help">未提供图案参考时，只使用底图已有图案及你写明的方向，不注入内置花型。</p>}
                        <label className="sr-field">
                            系列名称
                            <input aria-label="系列名称" value={project.form.series} maxLength={80} onChange={(event) => updateForm({ series: event.target.value })} />
                        </label>
                        <label className="sr-field">
                            必须保留
                            <textarea aria-label="必须保留" value={project.form.constraints} maxLength={2000} rows={3} onChange={(event) => updateForm({ constraints: event.target.value })} />
                        </label>
                        <label className="sr-field">
                            设计方向
                            <textarea aria-label="设计方向" value={project.form.prompt} maxLength={3000} rows={3} onChange={(event) => updateForm({ prompt: event.target.value })} />
                        </label>
                        <p className="sr-help">每次仅生成 1 个候选；可修改方向后再次发起独立任务。历史候选保留。</p>
                        {project.form.kind === "structure" ? (
                            <section className="sr-palette" aria-label="系列配色">
                                <h3>系列配色</h3>
                                <div className="sr-swatches">
                                    {project.form.palette.slice(0, project.form.count).map((color, index) => (
                                        <button key={index} type="button" aria-label={`编辑第 ${index + 1} 色 ${color.hex}`} aria-pressed={index === activeColor} onClick={() => setActiveColor(index)} style={{ background: color.hex }}>
                                            <span>{index + 1}</span>
                                        </button>
                                    ))}
                                </div>
                                <div className="sr-segments">
                                    <button type="button" aria-pressed={paletteMode === "manual"} onClick={() => setPaletteMode("manual")}>
                                        手动选色
                                    </button>
                                    <button type="button" aria-pressed={paletteMode === "random"} onClick={() => setPaletteMode("random")}>
                                        随机配色
                                    </button>
                                </div>
                                {paletteMode === "random" && (
                                    <div className="sr-inline">
                                        <select aria-label="配色风格" value={project.form.paletteStyle} onChange={(event) => updateForm({ paletteStyle: event.target.value as RecipeForm["paletteStyle"] })}>
                                            <option value="soft">柔和</option>
                                            <option value="vivid">鲜明</option>
                                            <option value="earth">大地</option>
                                            <option value="free">自由</option>
                                        </select>
                                        <button type="button" className="sr-button" onClick={() => updateForm({ palette: randomRecipePalette(project.form.paletteStyle) })}>
                                            <RefreshCw size={13} />
                                            换一组
                                        </button>
                                    </div>
                                )}
                                <label className="sr-field">
                                    第 {activeColor + 1} 色 · {project.form.palette[activeColor]!.name}
                                    <div className="sr-color-input">
                                        <input
                                            type="color"
                                            aria-label="选择当前颜色"
                                            value={project.form.palette[activeColor]!.hex}
                                            onChange={(event) => {
                                                const hex = event.target.value;
                                                updateForm({ palette: project.form.palette.map((color, index) => (index === activeColor ? { name: `自选色 ${index + 1}`, hex } : color)) });
                                            }}
                                        />
                                        <input aria-label="当前颜色 HEX" value={colorDraft} maxLength={7} onChange={(event) => setColorDraft(event.target.value)} />
                                        <button type="button" className="sr-button" onClick={applyColor}>
                                            应用
                                        </button>
                                    </div>
                                </label>
                                <p className="sr-help">数字配色只表达屏幕近似方向，不对应 Pantone 标准，也不保证模型逐像素遵循色值。</p>
                            </section>
                        ) : (
                            <section className="sr-positions">
                                <h3>每个候选的定位要求</h3>
                                {project.form.positions.slice(0, project.form.count).map((position, index) => (
                                    <label key={index} className="sr-field">
                                        候选 {index + 1}
                                        <input
                                            aria-label={`候选 ${index + 1} 定位`}
                                            value={position}
                                            maxLength={160}
                                            onChange={(event) => updateForm({ positions: project.form.positions.map((value, positionIndex) => (positionIndex === index ? event.target.value : value)) })}
                                        />
                                    </label>
                                ))}
                            </section>
                        )}
                        <details className="sr-details">
                            <summary>模型与出图设置</summary>
                            <ModelPicker toolKey="series-recipe" config={config} value={config.model} onChange={(value) => updateSettings("imageModel", value)} capability="image" fullWidth disabled={locked} />
                            <ImageSettingsPanel config={config} referenceCount={refs.length} onConfigChange={updateSettings} theme={theme} maxCount={1} showTitle={false} />
                        </details>
                        <details className="sr-details">
                            <summary>预览候选 1 的设计指令</summary>
                            <pre>{buildRecipePrompt(project.form, 0, refs.length > 1)}</pre>
                        </details>
                    </fieldset>
                </aside>
                <section className="sr-stage" aria-label="候选结果">
                    <div className="sr-stage-heading">
                        <div>
                            <span className="sr-eyebrow">SERIES / CANDIDATES</span>
                            <h2>{run?.form.series || project.form.series || "未命名系列"}</h2>
                        </div>
                        <span className="sr-phase" role="status">
                            {recovering ? "正在查询原任务" : active ? (paused ? "暂停后续分支 · 当前任务继续" : "真实模型生成中") : uncertain ? "有原任务待核查" : run ? `${succeeded} / ${branches.length} 已完成` : "等待参考图"}
                        </span>
                    </div>
                    <ol className="sr-flow">
                        <li>
                            <span>01</span>
                            <b>参考图</b>
                            <small>{run?.references[0]?.name || project.references[0]?.name || "上传产品底图"}</small>
                        </li>
                        <li>
                            <span>02</span>
                            <b>整理约束</b>
                            <small>用户输入，不冒充 AI 分析</small>
                        </li>
                        <li>
                            <span>03</span>
                            <b>{run?.form.count || project.form.count} 个独立分支</b>
                            <small>每个候选调用一次模型</small>
                        </li>
                        <li>
                            <span>04</span>
                            <b>选择与方案板</b>
                            <small>{selected.length} 个已入选</small>
                        </li>
                    </ol>
                    {dirty && <p className="sr-callout">当前草稿已修改。下方结果与失败重试仍使用原轮次冻结的参考图、配方和指令；“生成新一轮”使用当前设置。</p>}
                    {!run ? (
                        <div className="sr-empty">
                            {project.references[0] ? <img src={project.references[0].dataUrl} alt="当前参考底图预览" /> : <ImagePlus size={52} strokeWidth={1} />}
                            <h3>{project.references[0] ? "参考图已就位" : "从你的产品参考开始"}</h3>
                            <p>设置一个配色或定位方向，每次生成 1 个候选。修改方向后可再次生成；不会使用模拟改色图代替模型结果。</p>
                        </div>
                    ) : (
                        <div className="sr-results">
                            {branches.map((branch) => (
                                <article key={branch.id} className={`sr-result ${branch.selected ? "is-selected" : ""}`}>
                                    <button className="sr-result-image" type="button" disabled={!branch.images[0]} aria-label={`查看候选 ${branch.index + 1} 大图`} onClick={() => setPreview(branch.images[0] || null)}>
                                        {branch.images[0] ? (
                                            <img src={branch.images[0].dataUrl} alt={`候选 ${branch.index + 1}`} />
                                        ) : (
                                            <span>
                                                {branch.status === "running" ? <LoaderCircle size={28} className="animate-spin" /> : <Palette size={28} strokeWidth={1} />}
                                                {recipeStatusLabels[branch.status]}
                                            </span>
                                        )}
                                    </button>
                                    <div className="sr-result-body">
                                        <div className="sr-result-title">
                                            <h3>
                                                {run.form.kind === "structure" && <i style={{ background: run.form.palette[branch.index]!.hex }} />}候选 {String(branch.index + 1).padStart(2, "0")}
                                            </h3>
                                            <span>{recipeStatusLabels[branch.status]}</span>
                                        </div>
                                        <p>{run.form.kind === "structure" ? `${run.form.palette[branch.index]!.name} · ${run.form.palette[branch.index]!.hex.toUpperCase()}` : run.form.positions[branch.index]}</p>
                                        {branch.error && <p className="sr-error">{branch.error}</p>}
                                        <small>
                                            已尝试 {branch.attempts} 次{branch.taskIds[0] ? ` · 任务 ${branch.taskIds[0].slice(0, 10)}…` : ""}
                                        </small>
                                        <details>
                                            <summary>查看本候选原始指令与请求标识</summary>
                                            <pre>
                                                {branch.prompt}
                                                {branch.requestId ? `\n\nrequestId: ${branch.requestId}\ntaskIds: ${branch.taskIds.join(", ") || "尚未确认"}` : ""}
                                            </pre>
                                        </details>
                                        <label className="sr-selection">
                                            <input
                                                type="checkbox"
                                                disabled={active || working || branch.status !== "success"}
                                                checked={branch.selected}
                                                onChange={(event) => {
                                                    const old = projectRef.current;
                                                    if (old.run) commit({ ...old, run: { ...old.run, branches: old.run.branches.map((item) => (item.id === branch.id ? { ...item, selected: event.target.checked } : item)) } });
                                                }}
                                            />
                                            {branch.selected ? "已选入方案板" : "选入方案板"}
                                        </label>
                                    </div>
                                </article>
                            ))}
                        </div>
                    )}
                    <p className="sr-help sr-footer-note">候选来自真实 AI 任务。结构、花型和色彩仍需逐张验收；方案板只是所选结果的排版，不会再次调用模型。</p>
                </section>
                <aside className="sr-panel sr-controls" aria-label="运行控制和项目保存">
                    <div className="sr-panel-heading">
                        <h2>02 / 运行与交付</h2>
                    </div>
                    <div className="sr-control-body">
                        {validation && <p className="sr-help">{validation}</p>}
                        {business.status === "error" && (
                            <button className="sr-button" onClick={() => void business.refresh().catch(() => undefined)}>
                                重载模型配置
                            </button>
                        )}
                        <button type="button" className="sr-button sr-primary sr-wide" disabled={locked || !!validation || !!uncertain} onClick={() => void start("new")}>
                            <Play size={15} />
                            {run ? "生成新一轮" : "运行配方"}
                            <span>{project.form.count} 张</span>
                        </button>
                        <div className="sr-inline">
                            <button className="sr-button" type="button" disabled={!active || recovering} onClick={() => (paused ? runner.current?.resume() : runner.current?.pause())}>
                                {paused ? <Play size={14} /> : <Pause size={14} />}
                                {paused ? "继续分支" : "暂停后续"}
                            </button>
                            <button className="sr-button" type="button" disabled={!active} onClick={() => runner.current?.cancel()}>
                                <Square size={13} />
                                停止
                            </button>
                        </div>
                        <p className="sr-help">暂停不取消已提交任务；停止会结束本页查询和未开始分支，服务端任务可能仍继续。可通过原任务查询找回结果。</p>
                        {!!waiting && !active && (
                            <button type="button" className="sr-button sr-wide" disabled={locked || !enabled || !!uncertain} onClick={() => void start("waiting")}>
                                继续未提交分支 ({waiting})
                            </button>
                        )}
                        <button type="button" className="sr-button sr-wide" disabled={locked || !enabled || !failed} onClick={() => void start("failed")}>
                            <RefreshCw size={14} />
                            仅重试确认失败项 ({failed})
                        </button>
                        <button type="button" className="sr-button sr-wide" disabled={locked || !enabled || !uncertain} onClick={() => void start("recover")}>
                            查询原任务 ({uncertain}) · 不重新生成
                        </button>
                        <progress aria-label="分支完成进度" max={branches.length || project.form.count} value={completed} />
                        <p className="sr-help">
                            {succeeded} 个成功 · {failed} 个失败 · {uncertain} 个待核查
                        </p>
                        <div className="sr-estimate">
                            <span>本轮预估</span>
                            <strong>{estimate.configured ? `¥${estimate.rmbCost.toFixed(2)}` : "待配置"}</strong>
                            {deploymentFeatures.creditsEnabled && estimate.configured && <span>{estimate.credits} 积分</span>}
                        </div>
                        <p className="sr-help">每个分支独立提交；失败重试可能再次计费。预估不等于实付，最终以服务端任务与账单为准。</p>
                        <hr />
                        <h3>保存与导出</h3>
                        <button
                            type="button"
                            className="sr-button sr-wide"
                            disabled={locked}
                            onClick={() =>
                                void action(async () => {
                                    await persist(projectRef.current);
                                    if (current()) setNotice("已保存到当前员工的本地浏览器。");
                                })
                            }
                        >
                            <Save size={14} />
                            保存项目
                        </button>
                        <button type="button" className="sr-button sr-wide" disabled={locked || !selected.length} onClick={() => void exportBoard()}>
                            <Download size={14} />
                            方案板 PNG ({selected.length})
                        </button>
                        <button type="button" className="sr-button sr-wide" disabled={locked} onClick={() => void exportProject()}>
                            <Download size={14} />
                            导出完整项目 JSON
                        </button>
                        <label className={`sr-button sr-wide sr-file-button ${locked ? "is-disabled" : ""}`}>
                            <Upload size={14} />
                            导入项目 JSON
                            <input
                                type="file"
                                aria-label="导入系列配方项目"
                                accept="application/json,.json"
                                disabled={locked}
                                onChange={(event) => {
                                    const file = event.target.files?.[0];
                                    event.target.value = "";
                                    if (file) void importProject(file);
                                }}
                            />
                        </label>
                        <p className="sr-help">本地项目按员工分区，自动恢复。JSON 含原图和候选，可用于备份；不包含模型密钥。</p>
                        {working && (
                            <p className="sr-help" role="status">
                                正在处理图片或项目，请稍候…
                            </p>
                        )}
                        {notice && (
                            <p className="sr-notice" role="status">
                                {notice}
                            </p>
                        )}
                        {error && (
                            <p className="sr-error" role="alert">
                                {error}
                            </p>
                        )}
                    </div>
                </aside>
            </div>
            {preview && (
                <div className="sr-preview" role="dialog" aria-modal="true" aria-label="候选大图" onClick={() => setPreview(null)}>
                    <button type="button" aria-label="关闭大图" onClick={() => setPreview(null)} autoFocus>
                        <X size={24} />
                    </button>
                    <img src={preview.dataUrl} alt={preview.name} onClick={(event) => event.stopPropagation()} />
                </div>
            )}
        </main>
    );
}

function RecipeUpload({ label, image, disabled, onUpload, onRemove }: { label: string; image?: ReferenceImage; disabled: boolean; onUpload: (file: File) => void; onRemove: () => void }) {
    return (
        <div className="sr-upload-field">
            <span>{label}</span>
            <label className={`sr-upload ${disabled ? "is-disabled" : ""}`}>
                {image ? <img src={image.dataUrl} alt={label} /> : <ImagePlus size={26} strokeWidth={1.4} />}
                <span>
                    {image ? "点击替换参考图" : "选择 PNG / JPG / WebP"}
                    <small>原图保留 · 最大 15 MB</small>
                </span>
                <input
                    type="file"
                    aria-label={`上传${label}`}
                    accept="image/png,image/jpeg,image/webp"
                    disabled={disabled}
                    onChange={(event) => {
                        const file = event.target.files?.[0];
                        event.target.value = "";
                        if (file) onUpload(file);
                    }}
                />
            </label>
            {image && (
                <div className="sr-upload-name">
                    <span title={image.name}>{image.name}</span>
                    <button type="button" aria-label={`移除${label}`} disabled={disabled} onClick={onRemove}>
                        <X size={13} />
                    </button>
                </div>
            )}
        </div>
    );
}

function loadImage(dataUrl: string) {
    return new Promise<HTMLImageElement>((resolve, reject) => {
        const image = new Image();
        image.onload = () => (image.naturalWidth && image.naturalHeight ? resolve(image) : reject(new Error("图片内容无效")));
        image.onerror = () => reject(new Error("图片读取失败，请检查图片内容或文件权限"));
        image.src = dataUrl;
    });
}
function pollDelay(signal: AbortSignal) {
    return new Promise<void>((resolve, reject) => {
        signal.throwIfAborted();
        const finish = () => {
            signal.removeEventListener("abort", abort);
            resolve();
        };
        const timer = window.setTimeout(finish, 1000);
        const abort = () => {
            window.clearTimeout(timer);
            reject(new DOMException("已停止查询，原任务仍保留", "AbortError"));
        };
        signal.addEventListener("abort", abort, { once: true });
    });
}

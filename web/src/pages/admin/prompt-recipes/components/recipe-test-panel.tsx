import { useEffect, useRef, useState } from "react";
import { Alert, App, Button, Form, Image, Input, Select, Tag } from "antd";
import { createClientId } from "@/lib/client-id";
import {
    findAdminPromptCompilation,
    findAdminPromptImage,
    getAdminPromptCompilation,
    requirePromptAdmin,
    submitAdminPromptImage,
    testAdminPromptRecipe,
    type AdminPromptTestInput,
    type PromptAdminModel,
    type PromptRecipeDetail,
} from "@/services/api/admin-prompt-recipes";
import { uploadServerAsset } from "@/services/api/server-assets";
import type { QueuedTask } from "@/services/api/generation-tasks";
import { promptScenes, type AdminPromptCompilation, type PublicPromptCompilation } from "../../../../../../shared/prompt-contracts";
import { buildTestImage, buildTestPromptInput, jsonObject, messageOf } from "../model";
import { CompilationResult, compilationStatus } from "./compilation-history";

type Reference = { id: string; file: File; preview: string; serverUrl?: string };
type TestRun = { id: string; version: number; input: AdminPromptTestInput; compilation?: PublicPromptCompilation; diagnostic?: AdminPromptCompilation; notice?: string; taskRequestId?: string; task?: QueuedTask; taskNotice?: string };
const wait = (signal: AbortSignal) =>
    new Promise<void>((resolve, reject) => {
        const finish = () => {
            signal.removeEventListener("abort", abort);
            resolve();
        };
        const timer = window.setTimeout(finish, 2000);
        const abort = () => {
            clearTimeout(timer);
            reject(signal.reason);
        };
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
    });

export function RecipeTestPanel({ detail, models, refresh, editorDirty }: { detail: PromptRecipeDetail; models: PromptAdminModel[]; refresh: () => Promise<PromptRecipeDetail>; editorDirty: boolean }) {
    const { modal } = App.useApp();
    const owner = useRef(requirePromptAdmin()).current;
    const lifetime = useRef(new AbortController());
    const filesRef = useRef<Reference[]>([]);
    const [files, setFiles] = useState<Reference[]>([]);
    const [versionId, setVersionId] = useState(detail.recipe.currentVersionId || detail.versions[0]?.id || "");
    const scene = (promptScenes as readonly string[]).includes(detail.recipe.key) ? detail.recipe.key : "free-optimize";
    const [fieldsJson, setFieldsJson] = useState("{}");
    const [userText, setUserText] = useState("");
    const [rolesText, setRolesText] = useState("");
    const [mode, setMode] = useState<"generate" | "edit">("edit");
    const [language, setLanguage] = useState<"en" | "zh">("en");
    const [targetId, setTargetId] = useState("");
    const [optimizerId, setOptimizerId] = useState<string | undefined>();
    const [parametersJson, setParametersJson] = useState('{\n  "size": "1024x1024"\n}');
    const [runs, setRuns] = useState<TestRun[]>([]);
    const [compareIds, setCompareIds] = useState<string[]>([]);
    const [busy, setBusy] = useState("");
    const busyRef = useRef(false);
    const imageRequestIds = useRef(new Map<string, string>());
    const [error, setError] = useState("");
    useEffect(() => {
        lifetime.current = new AbortController();
        return () => {
            lifetime.current.abort();
            filesRef.current.forEach((file) => URL.revokeObjectURL(file.preview));
        };
    }, []);
    const options = () => ({ expectedOwnerId: owner, signal: lifetime.current.signal });
    const patchRun = (id: string, value: Partial<TestRun>) => {
        if (!lifetime.current.signal.aborted) setRuns((items) => items.map((run) => (run.id === id ? { ...run, ...value } : run)));
    };
    const start = async (key: string, action: () => Promise<void>) => {
        if (busyRef.current) return;
        busyRef.current = true;
        setBusy(key);
        setError("");
        try {
            requirePromptAdmin(owner);
            await action();
        } catch (reason) {
            if (!lifetime.current.signal.aborted) setError(messageOf(reason));
        } finally {
            busyRef.current = false;
            if (!lifetime.current.signal.aborted) setBusy("");
        }
    };
    const loadDiagnostic = async (run: TestRun, compilation: PublicPromptCompilation) => {
        patchRun(run.id, { compilation, notice: undefined });
        try {
            const result = await getAdminPromptCompilation(detail.recipe.key, compilation.id, options());
            patchRun(run.id, { diagnostic: result.compilation });
            await refresh();
        } catch (reason) {
            patchRun(run.id, { notice: `优化结果已保留；诊断读取失败：${messageOf(reason)}` });
        }
    };
    const observeCompilation = async (run: TestRun, initial?: PublicPromptCompilation) => {
        let result = initial;
        for (let attempt = 0; attempt < 60; attempt += 1) {
            lifetime.current.signal.throwIfAborted();
            requirePromptAdmin(owner);
            if (!result) result = (await findAdminPromptCompilation(run.id, options())) ?? undefined;
            if (!result) {
                patchRun(run.id, { notice: "尚未查到原请求，不能据此认定未扣费。请稍后查询，勿重复提交。" });
                return;
            }
            patchRun(run.id, { compilation: result });
            if (result.status !== "optimizing") {
                await loadDiagnostic(run, result);
                return;
            }
            await wait(lifetime.current.signal);
            result = undefined;
        }
        patchRun(run.id, { notice: "请求仍在优化中；自动查询已暂停，可继续查询原请求。不会自动重发。" });
    };
    const optimize = () =>
        start("optimize", async () => {
            if (editorDirty) throw new Error("请先保存编辑页的修改，再测试已保存版本");
            const version = detail.versions.find((entry) => entry.id === versionId);
            if (!version) throw new Error("请选择已保存的配方版本");
            const target = models.find((model) => model.id === targetId);
            if (!target || !target.capabilities.includes(mode === "edit" ? "edit" : "generate")) throw new Error("请选择支持当前模式的目标图像模型");
            if (!optimizerId && !detail.recipe.modelConfigId) throw new Error("请绑定配方优化模型，或选择本次测试模型");
            const promptInput = buildTestPromptInput({ scene, fieldsJson, userText, rolesText, mode, outputLanguage: language });
            const sourceUrls: string[] = [];
            for (const reference of filesRef.current) {
                lifetime.current.signal.throwIfAborted();
                requirePromptAdmin(owner);
                if (!reference.serverUrl) {
                    const assetId = await uploadServerAsset(reference.file, { title: reference.file.name, source: "admin-prompt-test-reference" }, options());
                    lifetime.current.signal.throwIfAborted();
                    requirePromptAdmin(owner);
                    reference.serverUrl = `/api/assets/${encodeURIComponent(assetId)}/content`;
                }
                sourceUrls.push(reference.serverUrl);
            }
            const id = createClientId();
            const input: AdminPromptTestInput = { requestId: id, modelConfigId: targetId, versionId, optimizerModelConfigId: optimizerId, promptInput, sourceUrls };
            const run: TestRun = { id, input, version: version.version };
            setRuns((items) => [run, ...items]);
            setCompareIds((ids) => [id, ...ids].slice(0, 2));
            try {
                const { compilation } = await testAdminPromptRecipe(detail.recipe.key, input, options());
                await observeCompilation(run, compilation);
            } catch (reason) {
                patchRun(id, { notice: `${messageOf(reason)}。请求编号：${id}；只查询原请求，不自动重发。` });
            }
        });
    const observeImage = async (run: TestRun, requestId: string, initial?: QueuedTask) => {
        let task = initial;
        for (let attempt = 0; attempt < 150; attempt += 1) {
            lifetime.current.signal.throwIfAborted();
            requirePromptAdmin(owner);
            if (!task) task = (await findAdminPromptImage(requestId, options())) ?? undefined;
            if (!task) {
                patchRun(run.id, { taskNotice: "尚未查到原出图任务，请稍后查询；不要重复生成。" });
                return;
            }
            patchRun(run.id, { task, taskNotice: undefined });
            if (["success", "failed", "cancelled", "paused"].includes(task.status)) return;
            await wait(lifetime.current.signal);
            task = undefined;
        }
        patchRun(run.id, { taskNotice: "任务仍在运行；自动查询已暂停，可继续查询原任务。" });
    };
    const createImage = (run: TestRun) => {
        if (run.taskRequestId || imageRequestIds.current.has(run.id) || !run.compilation) return;
        try {
            jsonObject(parametersJson, "出图参数");
        } catch (reason) {
            setError(messageOf(reason));
            return;
        }
        modal.confirm({
            title: `使用 v${run.version} 的测试结果出图？`,
            content: "将按这次测试冻结的模型、参考图与提示词创建 1 个正式出图任务，可能产生图像模型费用。当前表单的新修改不会影响此任务。",
            okText: "提交 1 张测试图",
            cancelText: "取消",
            onOk: () =>
                start(`image:${run.id}`, async () => {
                    // A second still-open confirmation must not submit another paid task.
                    if (imageRequestIds.current.has(run.id)) return;
                    const requestId = createClientId();
                    const payload = buildTestImage(run.input, run.compilation!, requestId, parametersJson);
                    imageRequestIds.current.set(run.id, requestId);
                    patchRun(run.id, { taskRequestId: requestId });
                    try {
                        const result = await submitAdminPromptImage(payload, options());
                        await observeImage(run, requestId, result.task);
                    } catch (reason) {
                        patchRun(run.id, { taskNotice: `${messageOf(reason)}。只查询原任务，勿重复生成。` });
                    }
                }),
        });
    };
    const addFiles = (incoming: FileList | null) => {
        if (!incoming) return;
        const accepted: Reference[] = [];
        for (const file of Array.from(incoming)) {
            if (!["image/png", "image/jpeg", "image/webp"].includes(file.type) || file.size > 20 * 1024 * 1024 || file.size === 0) {
                setError("仅支持非空 PNG / JPEG / WebP，每张不超过 20 MB");
                continue;
            }
            if (filesRef.current.length + accepted.length >= 8) {
                setError("提示词优化最多接受 8 张参考图，仍须遵守目标模型的参考图上限");
                break;
            }
            accepted.push({ id: createClientId(), file, preview: URL.createObjectURL(file) });
        }
        filesRef.current = [...filesRef.current, ...accepted];
        setFiles([...filesRef.current]);
    };
    const chosen = runs.filter((run) => compareIds.includes(run.id));
    return (
        <div className="flex min-w-0 flex-col gap-5">
            {error && <Alert type="error" showIcon title={error} />}
            <Alert type="warning" showIcon title="仅优化测试也可能产生文本模型费用；不会自动出图。" description="保存版本后测试。参考图只在点击测试时上传；此页不测试蒙版区域编辑。离开页面停止本地查询，不会取消已提交任务。" />
            {editorDirty && <Alert type="info" title="编辑页有未保存的修改，请先保存后再测试。" />}
            <section className="wb-surface p-4 sm:p-5">
                <Form layout="vertical" disabled={Boolean(busy)}>
                    <div className="grid gap-x-4 sm:grid-cols-2">
                        <Form.Item label="测试版本">
                            <Select
                                aria-label="测试版本"
                                value={versionId}
                                onChange={setVersionId}
                                options={detail.versions.map((version) => ({ value: version.id, label: `v${version.version}${version.id === detail.recipe.currentVersionId ? " · 线上" : " · 草稿 / 历史"}` }))}
                            />
                        </Form.Item>
                        <Form.Item label="场景标识">
                            <Input aria-label="场景标识" value={scene} readOnly />
                        </Form.Item>
                        <Form.Item label="生成模式">
                            <Select
                                aria-label="生成模式"
                                value={mode}
                                onChange={(value) => {
                                    setMode(value);
                                    setTargetId("");
                                }}
                                options={[
                                    { value: "edit", label: "编辑 / 参考图" },
                                    { value: "generate", label: "纯生成" },
                                ]}
                            />
                        </Form.Item>
                        <Form.Item label="目标图像模型">
                            <Select
                                aria-label="目标图像模型"
                                placeholder="请选择"
                                value={targetId || undefined}
                                onChange={setTargetId}
                                options={models.filter((model) => model.capabilities.includes(mode === "edit" ? "edit" : "generate")).map((model) => ({ value: model.id, label: `${model.name} · ${model.modelId}` }))}
                            />
                        </Form.Item>
                        <Form.Item label="本次优化模型（可选）" extra="留空使用配方独立绑定模型；不修改线上设置。">
                            <Select
                                aria-label="本次优化模型"
                                allowClear
                                placeholder="使用配方绑定模型"
                                value={optimizerId}
                                onChange={setOptimizerId}
                                options={models.filter((model) => model.capabilities.includes("chat")).map((model) => ({ value: model.id, label: `${model.name} · ${model.modelId}` }))}
                            />
                        </Form.Item>
                        <Form.Item label="测试输出语言">
                            <Select
                                aria-label="测试输出语言"
                                value={language}
                                onChange={setLanguage}
                                options={[
                                    { value: "en", label: "英文" },
                                    { value: "zh", label: "中文" },
                                ]}
                            />
                        </Form.Item>
                    </div>
                    <Form.Item label="场景字段（JSON 对象）">
                        <Input.TextArea aria-label="场景字段 JSON" rows={5} className="!font-mono" value={fieldsJson} onChange={(event) => setFieldsJson(event.target.value)} />
                    </Form.Item>
                    <Form.Item label="用户要求">
                        <Input.TextArea aria-label="用户要求" rows={4} value={userText} maxLength={20000} onChange={(event) => setUserText(event.target.value)} />
                    </Form.Item>
                    <Form.Item label="参考图分工（每行一项，与图片顺序对应）">
                        <Input.TextArea aria-label="参考图分工" rows={2} value={rolesText} onChange={(event) => setRolesText(event.target.value)} />
                    </Form.Item>
                    <Form.Item label="参考图片">
                        <input
                            aria-label="上传参考图片"
                            type="file"
                            multiple
                            accept="image/png,image/jpeg,image/webp"
                            disabled={Boolean(busy)}
                            onChange={(event) => {
                                addFiles(event.target.files);
                                event.target.value = "";
                            }}
                        />
                        <div className="mt-3 flex flex-wrap gap-3">
                            {files.map((reference, index) => (
                                <div key={reference.id} className="w-28">
                                    <img src={reference.preview} alt={`参考图 ${index + 1}`} className="h-24 w-28 rounded-lg border border-border object-contain" />
                                    <div className="mt-1 truncate text-xs" title={reference.file.name}>
                                        {index + 1}. {reference.file.name}
                                    </div>
                                    <Button
                                        size="small"
                                        disabled={Boolean(busy)}
                                        onClick={() => {
                                            URL.revokeObjectURL(reference.preview);
                                            filesRef.current = filesRef.current.filter((entry) => entry.id !== reference.id);
                                            setFiles([...filesRef.current]);
                                        }}
                                    >
                                        移除
                                    </Button>
                                </div>
                            ))}
                        </div>
                    </Form.Item>
                    <Button aria-label="仅优化测试" type="primary" loading={busy === "optimize"} disabled={Boolean(busy) || editorDirty} onClick={() => void optimize()}>
                        仅优化测试
                    </Button>
                </Form>
            </section>
            <section className="wb-surface p-4 sm:p-5">
                <h3 className="mb-3 font-semibold">测试结果与图片对比</h3>
                <Select
                    aria-label="选择测试结果"
                    mode="multiple"
                    className="w-full"
                    placeholder="选择最多两次测试并排对比"
                    value={compareIds}
                    onChange={(ids) => setCompareIds(ids.slice(-2))}
                    options={runs.map((run) => ({ value: run.id, label: `v${run.version} · ${run.compilation ? compilationStatus[run.compilation.status] : "待核查"} · ${run.id.slice(-8)}` }))}
                />
                <Form layout="vertical" className="mt-4">
                    <Form.Item label="出图参数（仅点击单条结果的“测试出图”时使用）" extra="按目标图像模型填写参数；count 固定为 1。测试结果与图片只保留在当前页面，任务本身由服务端保存。">
                        <Input.TextArea aria-label="出图参数 JSON" rows={3} className="!font-mono" value={parametersJson} disabled={Boolean(busy)} onChange={(event) => setParametersJson(event.target.value)} />
                    </Form.Item>
                </Form>
            </section>
            <div className="grid min-w-0 gap-4 xl:grid-cols-2">
                {chosen.map((run) => (
                    <section key={run.id} className="wb-surface min-w-0 p-4">
                        <h3 className="mb-2 font-semibold">
                            v{run.version} 测试 <Tag>{run.id.slice(-8)}</Tag>
                        </h3>
                        <p className="mb-3 break-all text-xs text-muted-foreground">请求编号：{run.id}</p>
                        {run.notice && <Alert type="warning" className="!mb-3" title={run.notice} />}
                        {run.diagnostic ? (
                            <CompilationResult compilation={run.diagnostic} />
                        ) : (
                            <>
                                <Tag>{run.compilation ? compilationStatus[run.compilation.status] : "提交结果待核查"}</Tag>
                                {run.compilation?.message && <Alert type="warning" title={run.compilation.message} />}
                                <pre className="mt-3 whitespace-pre-wrap break-words text-xs">{run.compilation?.summaryZh}</pre>
                                <pre className="mt-3 whitespace-pre-wrap break-words text-sm">{run.compilation?.prompt}</pre>
                            </>
                        )}
                        <div className="mt-4 flex flex-wrap gap-2">
                            <Button aria-label="查询原优化请求" disabled={Boolean(busy)} loading={busy === `query:${run.id}`} onClick={() => void start(`query:${run.id}`, () => observeCompilation(run))}>
                                查询原优化请求
                            </Button>
                            <Button aria-label="测试出图（1 张）" type="primary" disabled={Boolean(busy) || run.compilation?.status !== "success" || Boolean(run.taskRequestId)} loading={busy === `image:${run.id}`} onClick={() => createImage(run)}>
                                测试出图（1 张）
                            </Button>
                        </div>
                        {run.taskRequestId && (
                            <div className="mt-4 border-t border-border pt-4">
                                <p className="break-all text-xs">出图请求：{run.taskRequestId}</p>
                                <p className="my-2 text-sm">
                                    任务状态：{run.task?.status || "待核查"}
                                    {run.task?.failureReason ? ` · ${run.task.failureReason}` : ""}
                                </p>
                                {run.taskNotice && <Alert type="warning" title={run.taskNotice} />}
                                <Button className="my-3" disabled={Boolean(busy)} onClick={() => void start(`task-query:${run.id}`, () => observeImage(run, run.taskRequestId!))}>
                                    查询原出图任务
                                </Button>
                                <Image.PreviewGroup>
                                    <div className="grid grid-cols-1 gap-3">
                                        {run.task?.resultUrls
                                            .filter((url) => /^https?:\/\//.test(url) || url.startsWith("/api/"))
                                            .map((url, index) => (
                                                <Image key={url} src={url} alt={`v${run.version} 测试结果 ${index + 1}`} className="!max-h-[500px] !object-contain" />
                                            ))}
                                    </div>
                                </Image.PreviewGroup>
                            </div>
                        )}
                    </section>
                ))}
            </div>
        </div>
    );
}

import { useCallback, useEffect, useRef, useState } from "react";
import { App, Button, Empty, Image, InputNumber, Segmented, Tag } from "antd";
import { ClipboardPaste, Download, FolderPlus, Grid2x2, ImagePlus, LoaderCircle, RotateCcw, Upload } from "lucide-react";
import { saveAs } from "file-saver";
import { nanoid } from "nanoid";
import { useSearchParams } from "react-router-dom";

import { AssetPickerModal, type InsertAssetPayload } from "@/components/canvas/asset-picker-modal";
import { deploymentFeatures } from "@/lib/deployment-features";
import { resolveToolModel } from "@/services/api/business-config";
import { DEFAULT_SEAMLESS_STITCH_PARAMETERS, requestSeamlessStitch, type SeamlessStitchParameters } from "@/services/api/internal-ai";
import { listQueuedTasks, type QueuedTask } from "@/services/api/generation-tasks";
import { fetchServerAssetContent } from "@/services/api/server-assets";
import { hydratePromptReuse } from "@/services/api/prompts";
import { uploadImage, type UploadedImage } from "@/services/image-storage";
import { useAssetStore } from "@/stores/use-asset-store";
import { useBusinessConfigStore } from "@/stores/use-business-config-store";
import { useUserStore } from "@/stores/use-user-store";
import type { ReferenceImage } from "@/types/image";

const SEAMLESS_PRESETS = {
    small: { cutWidth: 100, redrawWidth: 100, blurAmount: 50, redrawStrength: 0.5, steps: 12 },
    large: DEFAULT_SEAMLESS_STITCH_PARAMETERS,
} as const;

type StitchPreset = keyof typeof SEAMLESS_PRESETS | "custom";

type StitchResult = { status: "idle" } | { status: "pending" } | { status: "failed"; error: string } | { status: "success"; image: UploadedImage; durationMs: number };

export function SeamlessStitchPage() {
    const { message, modal } = App.useApp();
    const [searchParams] = useSearchParams();
    const fileInputRef = useRef<HTMLInputElement>(null);
    const loadedReuseTokenRef = useRef(new Set<string>());
    const restoredHistoryTaskIdRef = useRef<string | null>(null);
    const runStitchRef = useRef<() => Promise<void>>(async () => undefined);
    const sourceRef = useRef<ReferenceImage | null>(null);
    const historyBusyRef = useRef(false);
    const previewSequenceRef = useRef(0);
    const submitLockRef = useRef(false);
    const mountedRef = useRef(true);
    const user = useUserStore((state) => state.user);
    const hydrateSession = useUserStore((state) => state.hydrateSession);
    const estimate = useBusinessConfigStore((state) => state.estimate);
    const models = useBusinessConfigStore((state) => state.models);
    const tools = useBusinessConfigStore((state) => state.tools);
    const addAsset = useAssetStore((state) => state.addAsset);
    const [source, setSource] = useState<ReferenceImage | null>(null);
    const [preset, setPreset] = useState<StitchPreset>(() => searchParams.get("preset") === "small" ? "small" : "large");
    const [parameters, setParameters] = useState<SeamlessStitchParameters>(() => readSeamlessParameters(searchParams));
    const [result, setResult] = useState<StitchResult>({ status: "idle" });
    const [running, setRunning] = useState(false);
    const [assetPickerOpen, setAssetPickerOpen] = useState(false);
    const [history, setHistory] = useState<QueuedTask[]>([]);
    const [historyLoading, setHistoryLoading] = useState(true);
    const [historyError, setHistoryError] = useState("");
    const [previewLoading, setPreviewLoading] = useState(false);
    const seamlessModel = resolveToolModel({ models, tools, prices: [] }, "seamless-stitch");
    const estimatedUsage = estimate({ operationType: "seamless_stitch", toolKey: "seamless-stitch", quantity: 1 });
    const quotaBlocked = deploymentFeatures.creditsEnabled && Boolean(user && estimatedUsage.configured && user.creditBalance < estimatedUsage.credits);

    const refreshHistory = useCallback(async () => {
        if (historyBusyRef.current) return;
        historyBusyRef.current = true;
        try {
            const tasks = await listQueuedTasks();
            if (!mountedRef.current) return;
            setHistory(tasks.filter((task) => task.operationType === "seamless_stitch").slice(0, 20));
            setHistoryError("");
        } catch {
            if (mountedRef.current) setHistoryError("历史记录暂时未能加载，当前图片仍可使用。");
        } finally {
            historyBusyRef.current = false;
            if (mountedRef.current) setHistoryLoading(false);
        }
    }, []);

    const openHistoryTask = async (task: QueuedTask) => {
        const imageUrl = task.resultUrls[0];
        if (!imageUrl || submitLockRef.current) return;
        const sequence = ++previewSequenceRef.current;
        setPreviewLoading(true);
        try {
            const image = await uploadImage(imageUrl);
            if (!mountedRef.current || sequence !== previewSequenceRef.current) return;
            restoredHistoryTaskIdRef.current = task.id;
            setResult({ status: "success", image, durationMs: 0 });
        } catch (error) {
            if (sequence === previewSequenceRef.current) message.error(error instanceof Error ? error.message : "历史图片读取失败");
        } finally {
            if (mountedRef.current && sequence === previewSequenceRef.current) setPreviewLoading(false);
        }
    };

    useEffect(() => {
        mountedRef.current = true;
        void refreshHistory();
        const onVisible = () => { if (document.visibilityState === "visible") void refreshHistory(); };
        document.addEventListener("visibilitychange", onVisible);
        return () => { mountedRef.current = false; ++previewSequenceRef.current; document.removeEventListener("visibilitychange", onVisible); };
    }, [refreshHistory]);
    const hasActiveHistory = history.some(task => ["queued", "pending", "processing", "running"].includes(task.status));
    useEffect(() => {
        if (!running && !hasActiveHistory) return;
        const timer = window.setInterval(() => { if (document.visibilityState === "visible") void refreshHistory(); }, 4_000);
        return () => window.clearInterval(timer);
    }, [hasActiveHistory, refreshHistory, running]);

    useEffect(() => {
        if (running || previewLoading || result.status !== "idle") return;
        const latest = history.find((task) => task.status === "success" && task.resultUrls[0]);
        if (!latest || latest.id === restoredHistoryTaskIdRef.current) return;
        // Auto-restore once; a broken preview can still be retried explicitly.
        restoredHistoryTaskIdRef.current = latest.id;
        void openHistoryTask(latest);
    }, [history, result.status, running, previewLoading]);

    const setSourceFromBlob = async (blob: Blob, name: string) => {
        const uploaded = await uploadImage(blob);
        const nextSource = { id: nanoid(), name, type: uploaded.mimeType, dataUrl: uploaded.url, url: uploaded.url, storageKey: uploaded.storageKey };
        sourceRef.current = nextSource;
        setSource(nextSource);
    };

    const uploadSource = async (files?: FileList | null) => {
        const file = Array.from(files || []).find((item) => item.type.startsWith("image/"));
        if (!file) {
            message.error("请选择图片文件");
            return;
        }
        try {
            await setSourceFromBlob(file, file.name);
        } catch (error) {
            message.error(error instanceof Error ? error.message : "图片上传失败");
        }
    };

    const pasteSource = async () => {
        try {
            const items = await navigator.clipboard.read();
            for (const item of items) {
                const imageType = item.types.find((type) => type.startsWith("image/"));
                if (!imageType) continue;
                await setSourceFromBlob(await item.getType(imageType), "clipboard-image.png");
                message.success("已读取剪切板图片");
                return;
            }
            message.error("剪切板里没有可读取的图片");
        } catch {
            message.error("无法读取剪切板图片");
        }
    };

    const insertAsset = async (payload: InsertAssetPayload) => {
        if (payload.kind !== "image") {
            message.warning("无缝拼接只能使用图片素材");
            return;
        }
        await setSourceFromBlob(await (await fetch(payload.dataUrl)).blob(), payload.title);
        setAssetPickerOpen(false);
    };

    const runStitch = async () => {
        if (submitLockRef.current) return;
        const activeSource = sourceRef.current || source;
        if (!activeSource) {
            message.error("请先上传一张需要无缝拼接的图片");
            return;
        }
        submitLockRef.current = true;
        setRunning(true);
        try {
        if (deploymentFeatures.authenticationEnabled) await hydrateSession();
        const currentUser = useUserStore.getState().user;
        if (deploymentFeatures.authenticationEnabled && (!currentUser || currentUser.status !== "active")) {
            message.error("当前设计师账号不可用");
            return;
        }
        if ((deploymentFeatures.creditsEnabled && !estimatedUsage.configured) || !seamlessModel) {
            message.error("管理员尚未启用无缝拼接模型或价格");
            return;
        }
        if (deploymentFeatures.creditsEnabled && currentUser && estimatedUsage.configured && currentUser.creditBalance < estimatedUsage.credits) {
            message.error(`额度不足：需要 ${estimatedUsage.credits} 积分，当前剩余 ${currentUser.creditBalance} 积分`);
            return;
        }

        const prompt = `无缝拼接：切割 ${parameters.cutWidth}，重绘 ${parameters.redrawWidth}，羽化 ${parameters.blurAmount}，强度 ${parameters.redrawStrength}，步数 ${parameters.steps}`;
        const startedAt = performance.now();
        ++previewSequenceRef.current;
        setPreviewLoading(false);
        setResult({ status: "pending" });
            const response = await requestSeamlessStitch(activeSource, parameters, seamlessModel.id);
            const uploaded = await uploadImage(response.dataUrl);
            addAsset({
                kind: "image",
                title: `${activeSource.name.replace(/\.[^.]+$/, "")} 无缝拼接`,
                coverUrl: uploaded.url,
                tags: ["无缝拼接"],
                source: "无缝拼接",
                data: { dataUrl: uploaded.url, storageKey: uploaded.storageKey, width: uploaded.width, height: uploaded.height, bytes: uploaded.bytes, mimeType: uploaded.mimeType },
                metadata: {
                    source: "image-page",
                    module: "无缝拼接",
                    toolMode: "seamless-stitch",
                    operationType: "seamless_stitch",
                    projectId: "tool-seamless-stitch",
                    designerId: currentUser?.id,
                    prompt,
                    model: seamlessModel.name,
                    modelId: seamlessModel.modelId,
                    sourceFile: activeSource.name,
                    sourceImage: activeSource.storageKey || activeSource.url || activeSource.dataUrl,
                    ...parameters,
                    recreatePath: `/image?tool=seamless-stitch&preset=${preset}&cutWidth=${parameters.cutWidth}&redrawWidth=${parameters.redrawWidth}&blurAmount=${parameters.blurAmount}&redrawStrength=${parameters.redrawStrength}&steps=${parameters.steps}`,
                },
            });
            setResult({ status: "success", image: uploaded, durationMs: performance.now() - startedAt });
            message.success(!deploymentFeatures.creditsEnabled ? "无缝拼接完成" : `无缝拼接完成，预计消耗 ${estimatedUsage.credits} 积分`);
        } catch (error) {
            const reason = error instanceof Error ? error.message : "无缝拼接失败";
            setResult({ status: "failed", error: reason });
            message.error(reason);
        } finally {
            submitLockRef.current = false;
            setRunning(false);
            void refreshHistory();
        }
    };
    runStitchRef.current = runStitch;

    useEffect(() => {
        const token = searchParams.get("reuseToken");
        if (!token || loadedReuseTokenRef.current.has(token)) return;
        loadedReuseTokenRef.current.add(token);
        void hydratePromptReuse(token).then(async (payload) => {
            const parameters = payload.template.parameters;
            const reusedParameters = readTemplateParameters(parameters);
            if (reusedParameters) {
                setParameters(reusedParameters);
                setPreset(matchesPreset(reusedParameters, SEAMLESS_PRESETS.small) ? "small" : matchesPreset(reusedParameters, SEAMLESS_PRESETS.large) ? "large" : "custom");
            }
            const firstAssetId = payload.template.referenceAssetIds[0];
            if (firstAssetId) await setSourceFromBlob(await fetchServerAssetContent(firstAssetId), "模板参考图.png");
            payload.warnings.forEach((warning) => message.warning(warning));
            const cost = payload.pricing.estimate?.totalCredits ?? estimatedUsage.credits;
            if (payload.mode === "fill_and_generate") {
                if (!firstAssetId) message.info("模板参数已填入，请先选择一张图片后再生成。");
                else modal.confirm({ title: "确认开始无缝拼接？", content: !deploymentFeatures.creditsEnabled ? "确认后将直接提交生成任务。" : `当前实际消耗 ${cost} 积分。确认后才会提交任务并扣费。`, okText: "确认生成", cancelText: "仅保留填入", onOk: () => runStitchRef.current() });
            } else message.success(!deploymentFeatures.creditsEnabled ? "模板已填入" : `模板已填入，当前消耗 ${cost} 积分/次`);
        }).catch((error) => {
            loadedReuseTokenRef.current.delete(token);
            message.error(error instanceof Error ? error.message : "模板复用失败");
        });
    }, [estimatedUsage.credits, message, modal, searchParams]);

    return (
        <div className="wb-page flex h-full min-h-0 flex-col overflow-hidden">
            <main className="grid min-h-0 flex-1 gap-4 overflow-y-auto p-4 xl:grid-cols-[340px_minmax(0,1fr)_210px] xl:overflow-hidden">
                <section className="wb-surface thin-scrollbar flex min-h-0 flex-col overflow-y-auto p-4">
                    <div className="flex items-start justify-between gap-3">
                        <div>
                            <div className="mb-3 grid size-10 place-items-center rounded-lg bg-stone-100 text-stone-600 dark:bg-stone-800 dark:text-stone-300">
                                <Grid2x2 className="size-5" />
                            </div>
                            <h1 className="text-2xl font-semibold">无缝拼接</h1>
                            <p className="mt-2 text-sm leading-6 text-stone-500 dark:text-stone-400">把单张花纹或纹理处理成可连续平铺的无缝素材。</p>
                        </div>
                        <Tag className="m-0 shrink-0">
                            {!deploymentFeatures.creditsEnabled ? "不计积分" : `${estimatedUsage.credits} 积分/次`}
                        </Tag>
                    </div>

                    <div className="mt-6">
                        <div className="mb-2 flex items-center justify-between gap-3">
                            <span className="text-base font-semibold">输入图片</span>
                            <div className="flex gap-2">
                                <Button size="small" icon={<ClipboardPaste className="size-3.5" />} onClick={() => void pasteSource()}>
                                    粘贴
                                </Button>
                                <Button size="small" icon={<FolderPlus className="size-3.5" />} onClick={() => setAssetPickerOpen(true)}>
                                    素材库
                                </Button>
                                <Button size="small" icon={<Upload className="size-3.5" />} onClick={() => fileInputRef.current?.click()}>
                                    上传
                                </Button>
                            </div>
                        </div>
                        <button
                            type="button"
                            className="group relative flex aspect-[4/3] w-full items-center justify-center overflow-hidden rounded-lg border border-dashed border-stone-300 bg-stone-50 transition hover:border-stone-500 dark:border-stone-700 dark:bg-stone-950/30"
                            onClick={() => fileInputRef.current?.click()}
                        >
                            {source ? (
                                <img src={source.dataUrl} alt={source.name} className="size-full object-contain" />
                            ) : (
                                <span className="flex flex-col items-center gap-3 text-sm text-stone-500">
                                    <span className="grid size-12 place-items-center rounded-full bg-white text-stone-500 shadow-sm dark:bg-stone-900">
                                        <ImagePlus className="size-5" />
                                    </span>
                                    选择一张花纹或纹理图片
                                </span>
                            )}
                        </button>
                        {source ? <div className="mt-2 truncate text-xs text-stone-500">{source.name}</div> : null}
                    </div>

                    <div className="mt-5">
                        <span className="mb-2 block text-sm font-semibold">花型预设</span>
                        <Segmented
                            block
                            value={preset}
                            disabled={running}
                            options={[{ label: "小花", value: "small" }, { label: "大花", value: "large" }, { label: "自定义", value: "custom" }]}
                            onChange={(value) => {
                                const nextPreset = value as StitchPreset;
                                setPreset(nextPreset);
                                if (nextPreset !== "custom") setParameters(SEAMLESS_PRESETS[nextPreset]);
                            }}
                        />
                    </div>
                    <div className="mt-3 grid grid-cols-2 gap-3">
                        <ParameterField label="切割宽度" value={parameters.cutWidth} disabled={running} onChange={(value) => updateParameter(setParameters, setPreset, "cutWidth", value)} />
                        <ParameterField label="重绘宽度" value={parameters.redrawWidth} disabled={running} onChange={(value) => updateParameter(setParameters, setPreset, "redrawWidth", value)} />
                        <ParameterField label="羽化" value={parameters.blurAmount} disabled={running} onChange={(value) => updateParameter(setParameters, setPreset, "blurAmount", value)} />
                        <ParameterField label="重绘强度" value={parameters.redrawStrength} disabled={running} min={0} max={1} step={0.1} onChange={(value) => updateParameter(setParameters, setPreset, "redrawStrength", value)} />
                        <ParameterField label="步数" value={parameters.steps} disabled={running} max={100} onChange={(value) => updateParameter(setParameters, setPreset, "steps", value)} />
                    </div>
                    <div className="mt-2 text-xs leading-5 text-stone-400">小花推荐 100 / 100 / 50 / 0.5；大花推荐 200 / 200 / 100 / 1。参数由真实内部工作流处理。</div>

                    <div className="mt-auto pt-6">
                        <div className="mb-3 rounded-lg border border-stone-200 bg-stone-50 px-3 py-2 text-xs dark:border-stone-800 dark:bg-stone-950">
                            <div className="flex items-center justify-between gap-3">
                                <span>{!deploymentFeatures.creditsEnabled ? "不计积分" : `本次消耗 ${estimatedUsage.credits} 积分`}</span>
                                <span>{!deploymentFeatures.authenticationEnabled ? "免登录" : (user ? `${user.displayName} 剩余 ${user.creditBalance}` : "未登录")}</span>
                            </div>
                            {quotaBlocked ? <div className="mt-1 text-red-500">额度不足，无法提交任务。</div> : null}
                        </div>
                        {!seamlessModel ? <p className="mb-3 text-xs leading-5 text-stone-500">此工具尚未配置，管理员启用无缝拼接模型后即可使用。</p> : null}
                        <Button type="primary" size="large" block icon={<Grid2x2 className="size-4" />} loading={running} disabled={!source || (deploymentFeatures.creditsEnabled && !estimatedUsage.configured) || !seamlessModel || running || quotaBlocked} onClick={() => void runStitch()}>
                            开始无缝拼接
                        </Button>
                    </div>
                </section>

                <section className="wb-surface thin-scrollbar min-h-0 overflow-y-auto p-4 lg:p-5">
                    <div className="mb-4 flex items-center justify-between gap-3">
                        <h2 className="text-lg font-semibold">处理结果</h2>
                        {previewLoading ? <span role="status" className="text-xs text-stone-500">正在读取历史图片…</span> : null}
                        {result.status === "success" ? <Tag color="green">已完成</Tag> : result.status === "pending" ? <Tag color="orange">处理中</Tag> : null}
                    </div>
                    {result.status === "pending" ? (
                        <div className="flex min-h-[520px] flex-col items-center justify-center rounded-lg border border-dashed border-orange-300 bg-orange-50/30 text-stone-500 dark:bg-orange-950/10">
                            <LoaderCircle className="mb-3 size-8 animate-spin text-orange-500" />
                            <span className="text-sm">正在生成无缝纹理</span>
                        </div>
                    ) : result.status === "success" ? (
                        <div>
                            <div className="overflow-hidden rounded-lg border border-stone-200 bg-stone-100 dark:border-stone-800 dark:bg-stone-950">
                                <Image src={result.image.url} alt="无缝拼接结果" className="max-h-[620px] w-full object-contain" />
                            </div>
                            <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
                                <div className="text-xs text-stone-500">
                                    {result.durationMs ? `${result.image.width}×${result.image.height} · ${(result.durationMs / 1000).toFixed(1)} 秒` : "历史处理结果"}
                                </div>
                                <div className="flex gap-2">
                                    <Button
                                        icon={<RotateCcw className="size-4" />}
                                        onClick={() => {
                                            const nextSource = { id: nanoid(), name: "seamless-result.png", type: result.image.mimeType, dataUrl: result.image.url, url: result.image.url, storageKey: result.image.storageKey };
                                            sourceRef.current = nextSource;
                                            setSource(nextSource);
                                        }}
                                    >
                                        继续拼接
                                    </Button>
                                    <Button type="primary" icon={<Download className="size-4" />} onClick={() => saveAs(result.image.url, "seamless-stitch.png")}>
                                        下载结果
                                    </Button>
                                </div>
                            </div>
                        </div>
                    ) : result.status === "failed" ? (
                        <div className="flex min-h-[520px] flex-col items-center justify-center rounded-lg border border-red-200 bg-red-50 px-6 text-center dark:border-red-950 dark:bg-red-950/20">
                            <p className="max-w-lg text-sm text-red-600 dark:text-red-300">{result.error}</p>
                            <Button className="mt-4" icon={<RotateCcw className="size-4" />} onClick={() => void runStitch()}>
                                重新处理
                            </Button>
                        </div>
                    ) : (
                        <div className="flex min-h-[520px] flex-col items-center justify-center rounded-lg border border-dashed border-stone-300 dark:border-stone-700">
                            <Grid2x2 className="mb-4 size-12 text-stone-300" />
                            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="先上传花纹图片，选择预设，再点击开始无缝拼接" />
                        </div>
                    )}
                </section>

                <aside className="wb-surface thin-scrollbar min-h-0 overflow-y-auto p-4">
                    <div className="mb-4 flex items-center justify-between gap-3">
                        <div>
                            <h2 className="text-base font-semibold">历史出图</h2>
                            <p className="mt-1 text-xs text-stone-500">最近 20 条无缝拼接任务</p>
                        </div>
                        <Tag>{history.length}</Tag>
                    </div>
                    {historyLoading ? <p role="status" className="py-8 text-center text-xs text-stone-500">正在加载历史…</p> : null}
                    {historyError ? <div role="alert" className="mb-3 text-xs leading-5 text-stone-500">{historyError}<Button size="small" className="mt-2" onClick={() => void refreshHistory()}>重试</Button></div> : null}
                    {history.length ? (
                        <div className="space-y-3">
                            {history.map((task) => {
                                const imageUrl = task.resultUrls[0];
                                const time = task.createdAt ? new Date(task.createdAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" }) : "刚刚";
                                return (
                                    <article key={task.id} className="overflow-hidden rounded-lg border border-stone-200 bg-stone-50 dark:border-stone-800 dark:bg-stone-950">
                                        {task.status === "success" && imageUrl ? <button type="button" disabled={running} className="block w-full" onClick={() => void openHistoryTask(task)} title="查看处理结果"><img loading="lazy" decoding="async" src={imageUrl} alt="无缝拼接历史结果" className="aspect-square w-full object-cover transition hover:opacity-80" /></button> : (
                                            <div className="flex aspect-square flex-col items-center justify-center gap-2 px-3 text-center text-xs text-stone-500">
                                                {task.status === "processing" ? <LoaderCircle className="size-5 animate-spin text-orange-500" /> : <Grid2x2 className="size-5 text-red-400" />}
                                                <span>{task.status === "processing" ? "正在等待内部 AI 返回" : task.failureReason || "处理失败"}</span>
                                            </div>
                                        )}
                                        <div className="flex items-center justify-between gap-2 px-3 py-2 text-xs">
                                            <span className={task.status === "success" ? "text-emerald-600" : task.status === "processing" ? "text-orange-600" : "text-red-500"}>{task.status === "success" ? "已完成" : task.status === "processing" ? "处理中" : "失败"}</span>
                                            <div className="flex items-center gap-2">
                                                {task.status === "success" && imageUrl ? <><button type="button" className="text-stone-500 hover:text-orange-600" onClick={() => void openHistoryTask(task)}>查看</button><button type="button" className="text-stone-500 hover:text-orange-600" onClick={() => saveAs(imageUrl, `seamless-stitch-${task.id.slice(0, 8)}.png`)}>下载</button></> : null}
                                                <span className="text-stone-400">{time}</span>
                                            </div>
                                        </div>
                                    </article>
                                );
                            })}
                        </div>
                    ) : (
                        <div className="flex min-h-48 flex-col items-center justify-center text-center">
                            <Grid2x2 className="mb-3 size-8 text-stone-300" />
                            <p className="text-sm text-stone-500">提交后的任务会保留在这里</p>
                        </div>
                    )}
                </aside>
            </main>

            <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                className="hidden"
                onChange={(event) => {
                    void uploadSource(event.target.files);
                    event.target.value = "";
                }}
            />
            <AssetPickerModal open={assetPickerOpen} defaultTab="my-assets" onInsert={(payload) => void insertAsset(payload)} onClose={() => setAssetPickerOpen(false)} />
        </div>
    );
}

function ParameterField({ label, value, min = 1, max = 2_000, step = 1, disabled, onChange }: { label: string; value: number; min?: number; max?: number; step?: number; disabled: boolean; onChange: (value: number | null) => void }) {
    return <label className="min-w-0"><span className="mb-2 block text-xs font-medium text-stone-600 dark:text-stone-300">{label}</span><InputNumber className="w-full" value={value} min={min} max={max} step={step} disabled={disabled} onChange={onChange} /></label>;
}

function updateParameter(setParameters: React.Dispatch<React.SetStateAction<SeamlessStitchParameters>>, setPreset: React.Dispatch<React.SetStateAction<StitchPreset>>, key: keyof SeamlessStitchParameters, value: number | null) {
    if (value === null || !Number.isFinite(value)) return;
    setPreset("custom");
    setParameters((current) => ({ ...current, [key]: value }));
}

function readSeamlessParameters(searchParams: URLSearchParams): SeamlessStitchParameters {
    const preset = searchParams.get("preset") === "small" ? SEAMLESS_PRESETS.small : SEAMLESS_PRESETS.large;
    return {
        cutWidth: readNumber(searchParams.get("cutWidth"), preset.cutWidth, 1, 2_000),
        redrawWidth: readNumber(searchParams.get("redrawWidth"), preset.redrawWidth, 1, 2_000),
        blurAmount: readNumber(searchParams.get("blurAmount"), preset.blurAmount, 1, 2_000),
        redrawStrength: readNumber(searchParams.get("redrawStrength"), preset.redrawStrength, 0, 1),
        steps: readNumber(searchParams.get("steps"), preset.steps, 1, 100),
    };
}

function readTemplateParameters(value: Record<string, unknown>): SeamlessStitchParameters | null {
    const parsed = {
        cutWidth: value.cutWidth,
        redrawWidth: value.redrawWidth,
        blurAmount: value.blurAmount,
        redrawStrength: value.redrawStrength,
        steps: value.steps,
    };
    return Object.values(parsed).every((item) => typeof item === "number") ? parsed as SeamlessStitchParameters : null;
}

function matchesPreset(parameters: SeamlessStitchParameters, preset: SeamlessStitchParameters) {
    return Object.entries(preset).every(([key, value]) => parameters[key as keyof SeamlessStitchParameters] === value);
}

function readNumber(value: string | null, fallback: number, min: number, max: number) {
    if (value === null || value.trim() === "") return fallback;
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

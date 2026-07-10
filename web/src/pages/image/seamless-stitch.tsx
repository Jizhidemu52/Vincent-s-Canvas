import { useRef, useState } from "react";
import { App, Button, Empty, Image, Segmented, Tag } from "antd";
import { ClipboardPaste, Download, FolderPlus, Grid2x2, ImagePlus, LoaderCircle, RotateCcw, Upload } from "lucide-react";
import { saveAs } from "file-saver";
import { nanoid } from "nanoid";
import { useSearchParams } from "react-router-dom";

import { AssetPickerModal, type InsertAssetPayload } from "@/components/canvas/asset-picker-modal";
import { requestSeamlessStitch } from "@/services/api/internal-ai";
import { uploadImage, type UploadedImage } from "@/services/image-storage";
import { useAssetStore } from "@/stores/use-asset-store";
import { useBusinessConfigStore } from "@/stores/use-business-config-store";
import { useUserStore } from "@/stores/use-user-store";
import type { ReferenceImage } from "@/types/image";

const INTERNAL_SEAMLESS_MODEL_ID = "internal-seamless";
const MULTIPLIER_OPTIONS = [2, 4, 6, 8];

type StitchResult = { status: "idle" } | { status: "pending" } | { status: "failed"; error: string } | { status: "success"; image: UploadedImage; durationMs: number };

export function SeamlessStitchPage() {
    const { message } = App.useApp();
    const [searchParams] = useSearchParams();
    const fileInputRef = useRef<HTMLInputElement>(null);
    const user = useUserStore((state) => state.user);
    const estimate = useBusinessConfigStore((state) => state.estimate);
    const addAsset = useAssetStore((state) => state.addAsset);
    const [source, setSource] = useState<ReferenceImage | null>(null);
    const [rows, setRows] = useState(() => readMultiplier(searchParams.get("rows")));
    const [cols, setCols] = useState(() => readMultiplier(searchParams.get("cols")));
    const [result, setResult] = useState<StitchResult>({ status: "idle" });
    const [running, setRunning] = useState(false);
    const [assetPickerOpen, setAssetPickerOpen] = useState(false);
    const estimatedUsage = estimate({ operationType: "seamless_stitch", modelId: INTERNAL_SEAMLESS_MODEL_ID, quantity: 1 });
    const quotaBlocked = Boolean(user && estimatedUsage.configured && user.creditBalance < estimatedUsage.credits);

    const setSourceFromBlob = async (blob: Blob, name: string) => {
        const uploaded = await uploadImage(blob);
        setSource({ id: nanoid(), name, type: uploaded.mimeType, dataUrl: uploaded.url, url: uploaded.url, storageKey: uploaded.storageKey });
        setResult({ status: "idle" });
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
        if (running) return;
        if (!source) {
            message.error("请先上传一张需要无缝拼接的图片");
            return;
        }
        if (!user || user.status !== "active") {
            message.error("当前设计师账号不可用");
            return;
        }
        if (quotaBlocked) {
            message.error(`额度不足：需要 ${estimatedUsage.credits} 积分，当前剩余 ${user.creditBalance} 积分`);
            return;
        }

        const prompt = `无缝拼接，横向倍率 ${rows}，纵向倍率 ${cols}`;
        const startedAt = performance.now();
        setRunning(true);
        setResult({ status: "pending" });
        try {
            const response = await requestSeamlessStitch(source, rows, cols);
            const uploaded = await uploadImage(response.dataUrl);
            addAsset({
                kind: "image",
                title: `${source.name.replace(/\.[^.]+$/, "")} 无缝拼接`,
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
                    designerId: user.id,
                    prompt,
                    model: INTERNAL_SEAMLESS_MODEL_ID,
                    modelId: INTERNAL_SEAMLESS_MODEL_ID,
                    sourceFile: source.name,
                    sourceImage: source.storageKey || source.url || source.dataUrl,
                    rows,
                    cols,
                    recreatePath: `/image?tool=seamless-stitch&rows=${rows}&cols=${cols}`,
                },
            });
            setResult({ status: "success", image: uploaded, durationMs: performance.now() - startedAt });
            message.success(`无缝拼接完成，预计消耗 ${estimatedUsage.credits} 积分`);
        } catch (error) {
            const reason = error instanceof Error ? error.message : "无缝拼接失败";
            setResult({ status: "failed", error: reason });
            message.error(reason);
        } finally {
            setRunning(false);
        }
    };

    return (
        <div className="flex h-full min-h-0 flex-col overflow-hidden bg-stone-50 text-stone-950 dark:bg-stone-950 dark:text-stone-100">
            <main className="grid min-h-0 flex-1 gap-3 overflow-y-auto p-3 lg:grid-cols-[390px_minmax(0,1fr)] lg:overflow-hidden">
                <section className="thin-scrollbar flex min-h-0 flex-col overflow-y-auto rounded-lg border border-stone-200 bg-white p-4 shadow-sm dark:border-stone-800 dark:bg-stone-900">
                    <div className="flex items-start justify-between gap-3">
                        <div>
                            <div className="mb-3 grid size-10 place-items-center rounded-lg bg-black text-orange-300">
                                <Grid2x2 className="size-5" />
                            </div>
                            <h1 className="text-2xl font-semibold">无缝拼接</h1>
                            <p className="mt-2 text-sm leading-6 text-stone-500 dark:text-stone-400">把单张花纹或纹理处理成可连续平铺的无缝素材。</p>
                        </div>
                        <Tag color="orange" className="m-0 shrink-0">
                            {estimatedUsage.credits} 积分/次
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
                            className="group relative flex aspect-[4/3] w-full items-center justify-center overflow-hidden rounded-lg border border-dashed border-orange-300 bg-orange-50/40 transition hover:border-orange-500 dark:bg-orange-950/10"
                            onClick={() => fileInputRef.current?.click()}
                        >
                            {source ? (
                                <img src={source.dataUrl} alt={source.name} className="size-full object-contain" />
                            ) : (
                                <span className="flex flex-col items-center gap-3 text-sm text-stone-500">
                                    <span className="grid size-12 place-items-center rounded-full bg-white text-orange-500 shadow-sm dark:bg-stone-900">
                                        <ImagePlus className="size-5" />
                                    </span>
                                    选择一张花纹或纹理图片
                                </span>
                            )}
                        </button>
                        {source ? <div className="mt-2 truncate text-xs text-stone-500">{source.name}</div> : null}
                    </div>

                    <div className="mt-5 grid grid-cols-2 gap-3">
                        <label className="min-w-0">
                            <span className="mb-2 block text-sm font-semibold">横向倍率</span>
                            <Segmented block value={rows} options={MULTIPLIER_OPTIONS} disabled={running} onChange={(value) => setRows(Number(value))} />
                        </label>
                        <label className="min-w-0">
                            <span className="mb-2 block text-sm font-semibold">纵向倍率</span>
                            <Segmented block value={cols} options={MULTIPLIER_OPTIONS} disabled={running} onChange={(value) => setCols(Number(value))} />
                        </label>
                    </div>
                    <div className="mt-2 text-xs text-stone-400">倍率必须是 2 的倍数。</div>

                    <div className="mt-auto pt-6">
                        <div className="mb-3 rounded-lg border border-stone-200 bg-stone-50 px-3 py-2 text-xs dark:border-stone-800 dark:bg-stone-950">
                            <div className="flex items-center justify-between gap-3">
                                <span>本次消耗 {estimatedUsage.credits} 积分</span>
                                <span>{user ? `${user.displayName} 剩余 ${user.creditBalance}` : "未登录"}</span>
                            </div>
                            {quotaBlocked ? <div className="mt-1 text-red-500">额度不足，无法提交任务。</div> : null}
                        </div>
                        <Button type="primary" size="large" block icon={<Grid2x2 className="size-4" />} loading={running} disabled={quotaBlocked || running} onClick={() => void runStitch()}>
                            开始无缝拼接
                        </Button>
                    </div>
                </section>

                <section className="thin-scrollbar min-h-0 overflow-y-auto rounded-lg border border-stone-200 bg-white p-4 shadow-sm dark:border-stone-800 dark:bg-stone-900 lg:p-5">
                    <div className="mb-4 flex items-center justify-between gap-3">
                        <h2 className="text-xl font-semibold">处理结果</h2>
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
                                    {result.image.width}×{result.image.height} · {(result.durationMs / 1000).toFixed(1)} 秒
                                </div>
                                <div className="flex gap-2">
                                    <Button
                                        icon={<RotateCcw className="size-4" />}
                                        onClick={() => {
                                            setSource({ id: nanoid(), name: "seamless-result.png", type: result.image.mimeType, dataUrl: result.image.url, url: result.image.url, storageKey: result.image.storageKey });
                                            setResult({ status: "idle" });
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
                            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="处理结果将在这里显示" />
                        </div>
                    )}
                </section>
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

function readMultiplier(value: string | null) {
    const parsed = Number(value);
    return MULTIPLIER_OPTIONS.includes(parsed) ? parsed : 2;
}

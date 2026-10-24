import { useRef, useState } from "react";
import { App, Button, Modal, Radio } from "antd";
import { Download } from "lucide-react";

import { canvasThemes } from "@/lib/canvas-theme";
import { loadCanvasExport } from "@/lib/canvas/canvas-export-loader";
import type { ServerAssetVariant, ServerAssetVariants } from "@/services/api/server-assets";
import { useThemeStore } from "@/stores/use-theme-store";
import type { CanvasNodeData } from "@/types/canvas";

export function CanvasImageDownloadDialog({ node, variants, onClose }: {
    node: CanvasNodeData;
    variants: ServerAssetVariants | null;
    onClose: () => void;
}) {
    const { message } = App.useApp();
    const theme = canvasThemes[useThemeStore(state => state.theme)];
    const [downloading, setDownloading] = useState<string | null>(null);
    const [format, setFormat] = useState<"png" | "jpg">("png");
    const busy = useRef(false);
    const options: { key: "primary" | "original" | "export"; title: string; description: string; variant: ServerAssetVariant }[] = variants ? [
        { key: "primary", title: "下载显示结果", description: variants.maskComposited ? "严格蒙版 PNG 主图，保证蒙版区域外像素不变。" : "当前画布显示的图片，保留已保存的原始字节。", variant: variants.primary },
    ] : [];
    if (variants && variants.original.assetId !== variants.primary.assetId) options.push({ key: "original", title: "下载渠道原件", description: "渠道直接返回的图像，未经蒙版合成或格式转换；不保证蒙版区域外不变。", variant: variants.original });
    if (variants?.export && variants.export.assetId !== variants.primary.assetId) options.push({ key: "export", title: `下载 ${imageFormat(variants.export)} 格式副本`, description: "已按指定格式转换；有损导出不保证蒙版区域外逐像素一致。", variant: variants.export });

    const download = async (option: (typeof options)[number]) => {
        if (busy.current) return;
        busy.current = true;
        setDownloading(option.key);
        try {
            const { downloadCanvasImageVariant } = await loadCanvasExport();
            await downloadCanvasImageVariant(node, option.variant, option.key);
        } catch (error) {
            message.error(error instanceof Error ? error.message : "图片下载失败");
        } finally { busy.current = false; setDownloading(null); }
    };

    const downloadCurrent = async (selectedFormat: "original" | "png" | "jpg") => {
        if (busy.current) return;
        busy.current = true;
        setDownloading(selectedFormat);
        try {
            const { downloadCanvasImage } = await loadCanvasExport();
            await downloadCanvasImage(node, selectedFormat);
        } catch (error) {
            message.error(error instanceof Error ? error.message : "图片下载失败");
        } finally { busy.current = false; setDownloading(null); }
    };

    return (
        <Modal title="下载图片" open centered footer={null} onCancel={onClose} closable={!downloading} keyboard={!downloading} mask={{ closable: !downloading }} width={480} destroyOnHidden>
            <div className="space-y-5 py-1">
                <div className="space-y-3">
                    <p className="m-0 text-sm font-medium">当前图片导出格式</p>
                    <Radio.Group aria-label="图片下载格式" value={format} disabled={downloading !== null} onChange={event => setFormat(event.target.value)} options={[{ value: "png", label: "PNG（保留透明）" }, { value: "jpg", label: "JPG（白底）" }]} />
                    <Button type="primary" block icon={<Download className="size-4" />} loading={downloading === format} disabled={downloading !== null && downloading !== format} onClick={() => void downloadCurrent(format)}>下载 {format.toUpperCase()} 图片</Button>
                    <p className="m-0 text-xs leading-5" style={{ color: theme.node.muted }}>保持原图像素尺寸，不裁切、不修改画布原图。PNG 保留已有透明区域；JPG 为高质量有损格式，透明区域填充白色，不保证逐像素一致。格式转换时，动态图仅导出静态画面。</p>
                </div>
                {variants?.warning ? <p role="alert" className="m-0 text-sm leading-6" style={{ color: theme.toolbar.primary }}>后处理提示：{variants.warning}</p> : null}
                {!variants ? <div><Button block icon={<Download className="size-4" />} loading={downloading === "original"} disabled={downloading !== null && downloading !== "original"} onClick={() => void downloadCurrent("original")}>下载原文件（不转换）</Button><p className="mb-0 mt-2 text-xs leading-5" style={{ color: theme.node.muted }}>保留当前图片的原始格式与文件内容。</p></div> : null}
                {options.map(option => (
                    <div key={option.key}>
                        <Button block icon={<Download className="size-4" />} loading={downloading === option.key} disabled={downloading !== null && downloading !== option.key} onClick={() => void download(option)}>
                            {option.title}{option.key !== "export" ? `（${imageFormat(option.variant)}）` : ""}
                        </Button>
                        <p className="mb-0 mt-2 text-xs leading-5" style={{ color: theme.node.muted }}>{option.description}</p>
                    </div>
                ))}
            </div>
        </Modal>
    );
}

function imageFormat(variant: ServerAssetVariant) {
    return variant.mimeType.replace(/^image\//, "").toUpperCase();
}

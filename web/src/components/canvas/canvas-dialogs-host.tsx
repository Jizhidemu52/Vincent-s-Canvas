import { lazy, memo, Suspense, useMemo } from "react";
import { Button, Input, Modal } from "antd";
import { useCanvasGraphStore } from "@/stores/canvas/canvas-graph-store";
import { useCanvasStore } from "@/stores/canvas/use-canvas-store";
import { useThemeStore } from "@/stores/use-theme-store";
import { useModuleEnabled } from "@/stores/use-module-store";
import { useBusinessConfigStore } from "@/stores/use-business-config-store";
import { useEffectiveConfig, modelOptionName } from "@/stores/use-config-store";
import { useToolConfig } from "@/hooks/use-tool-config";
import { canvasThemes } from "@/lib/canvas-theme";
import type { useCanvasDialogs } from "@/pages/canvas/use-canvas-dialogs";
import type { CanvasNodeData } from "@/types/canvas";
import type { UploadedImage } from "@/services/image-storage";
import type { CanvasImageCropRect } from "./canvas-node-crop-dialog";
import type { CanvasImageMaskEditPayload } from "./canvas-node-mask-edit-dialog";
import type { CanvasImageSplitParams } from "./canvas-node-split-dialog";
import type { CanvasImageUpscaleParams } from "./canvas-node-upscale-dialog";
import type { CanvasImageAngleParams } from "./canvas-node-angle-dialog";
import type { CanvasDesignTemplateId, CanvasDesignTemplateSteps } from "@/lib/canvas/canvas-design-templates";
import type { InsertAssetPayload } from "./asset-picker-modal";
import { loadCanvasNodeInfoModal } from "@/lib/canvas/canvas-node-hover-loaders";
import { loadAssetPickerModal, loadCanvasNodeAngleDialog, loadCanvasNodeCropDialog, loadCanvasImageEditorDialog, loadCanvasNodeMaskEditDialog, loadCanvasNodeSplitDialog, loadCanvasNodeUpscaleDialog } from "@/lib/canvas/canvas-node-tool-loaders";

const CanvasImageCompareDialog = lazy(() => import("@/components/canvas/canvas-image-compare-dialog").then(module => ({ default: module.CanvasImageCompareDialog })));
const CanvasDesignTemplateDialog = lazy(() => import("@/components/canvas/canvas-design-template-dialog").then(module => ({ default: module.CanvasDesignTemplateDialog })));
const CanvasGroupNameDialog = lazy(() => import("@/components/canvas/canvas-group-name-dialog").then(module => ({ default: module.CanvasGroupNameDialog })));
const CanvasNodeAngleDialog = lazy(loadCanvasNodeAngleDialog);
const CanvasNodeCropDialog = lazy(loadCanvasNodeCropDialog);
const CanvasImageEditorDialog = lazy(loadCanvasImageEditorDialog);
const CanvasImagePdfDialog = lazy(() => import("@/components/canvas/canvas-image-pdf-dialog").then(module => ({ default: module.CanvasImagePdfDialog })));
const CanvasImageDownloadDialog = lazy(() => import("@/pages/canvas/canvas-image-download-dialog").then(module => ({ default: module.CanvasImageDownloadDialog })));
const CanvasNodeMaskEditDialog = lazy(loadCanvasNodeMaskEditDialog);
const CanvasNodeSplitDialog = lazy(loadCanvasNodeSplitDialog);
const CanvasNodeUpscaleDialog = lazy(loadCanvasNodeUpscaleDialog);
const AssetPickerModal = lazy(loadAssetPickerModal);
const CanvasNodeInfoModal = lazy(loadCanvasNodeInfoModal);

type DialogActions = {
    applyDesignTemplate: (id: CanvasDesignTemplateId, steps: CanvasDesignTemplateSteps, title?: string) => void;
    saveGroupName: (name: string) => void; saveNodeName: () => void; clearCanvas: () => void;
    saveManualImageEdit: (image: UploadedImage) => Promise<void>;
    cropImageNode: (node: CanvasNodeData, crop: CanvasImageCropRect) => Promise<void>;
    maskEditImageNode: (node: CanvasNodeData, payload: CanvasImageMaskEditPayload) => Promise<void>;
    splitImageNode: (node: CanvasNodeData, params: CanvasImageSplitParams) => Promise<void>;
    upscaleImageNode: (node: CanvasNodeData, params: CanvasImageUpscaleParams) => Promise<void>;
    generateAngleNode: (node: CanvasNodeData, params: CanvasImageAngleParams) => Promise<void>;
    handleAssetInsert: (payload: InsertAssetPayload) => void;
};
export const CanvasDialogsHost = memo(function CanvasDialogsHost({ projectId, state, actions }: {
    projectId: string; state: ReturnType<typeof useCanvasDialogs>; actions: DialogActions;
}) {
    const { compareImageIds, setCompareImageIds, templateSourceId, setTemplateSourceId, clearConfirmOpen, setClearConfirmOpen, assetPickerOpen, setAssetPickerOpen, infoNodeId, setInfoNodeId, cropNodeId, setCropNodeId, manualEditNode, setManualEditNode, imageExport, setImageExport, imageDownload, setImageDownload, renameNode, setRenameNode, renameGroup, setRenameGroup, maskEditNodeId, setMaskEditNodeId, maskEditModel, setMaskEditModel, splitNodeId, setSplitNodeId, upscaleNodeId, setUpscaleNodeId, superResolveNodeId, setSuperResolveNodeId, angleNodeId, setAngleNodeId, previewNodeId, setPreviewNodeId } = state;
    const { applyDesignTemplate, saveGroupName, saveNodeName, saveManualImageEdit, cropImageNode, maskEditImageNode,
        splitImageNode, upscaleImageNode, generateAngleNode, clearCanvas, handleAssetInsert } = actions;
    const nodes = useCanvasGraphStore(graph => graph.nodes);
    const nodeById = useCanvasGraphStore(graph => graph.nodeById);
    const currentProject = useCanvasStore(store => store.projects.find(project => project.id === projectId));
    const theme = canvasThemes[useThemeStore(store => store.theme)];
    const localToolsEnabled = useModuleEnabled("canvas-local-tools");
    const maskEditEnabled = useModuleEnabled("canvas-mask-edit");
    const angleEditEnabled = useModuleEnabled("canvas-angle");
    const effectiveConfig = useEffectiveConfig();
    const estimateUsage = useBusinessConfigStore(store => store.estimate);
    const selectedMaskEditModel = useToolConfig({ ...effectiveConfig, model: maskEditModel || effectiveConfig.imageModel || effectiveConfig.model }, "canvas-mask-edit").model;
    const maskEditEstimate = useMemo(() => estimateUsage({ operationType: "inpaint", toolKey: "canvas-mask-edit", modelId: modelOptionName(selectedMaskEditModel), quantity: 1 }), [estimateUsage, selectedMaskEditModel]);
    const infoNode = infoNodeId ? nodeById.get(infoNodeId) || null : null;
    const cropNode = cropNodeId ? nodeById.get(cropNodeId) || null : null;
    const maskEditNode = maskEditNodeId ? nodeById.get(maskEditNodeId) || null : null;
    const splitNode = splitNodeId ? nodeById.get(splitNodeId) || null : null;
    const upscaleNode = upscaleNodeId ? nodeById.get(upscaleNodeId) || null : null;
    const superResolveNode = superResolveNodeId ? nodeById.get(superResolveNodeId) || null : null;
    const angleNode = angleNodeId ? nodeById.get(angleNodeId) || null : null;
    const previewNode = previewNodeId ? nodeById.get(previewNodeId) || null : null;
    return <>
                {localToolsEnabled && compareImageIds ? <Suspense fallback={null}><CanvasImageCompareDialog nodes={nodes} initialIds={compareImageIds} onClose={() => setCompareImageIds(null)} /></Suspense> : null}
                {localToolsEnabled && templateSourceId !== undefined ? <Suspense fallback={null}><CanvasDesignTemplateDialog hasReference={Boolean(templateSourceId)} onApply={applyDesignTemplate} onClose={() => setTemplateSourceId(undefined)} /></Suspense> : null}
                {renameGroup ? <Suspense fallback={null}><CanvasGroupNameDialog key={renameGroup.id} initialName={renameGroup.name} onClose={() => setRenameGroup(null)} onSave={saveGroupName} /></Suspense> : null}

                <Modal title="重命名图片或节点" open={Boolean(renameNode)} onCancel={() => setRenameNode(null)} onOk={saveNodeName} okText="保存名称" cancelText="取消" okButtonProps={{ disabled: !renameNode?.name.trim() }} destroyOnHidden>
                    <Input aria-label="图片或节点名称" autoFocus maxLength={120} value={renameNode?.name || ""} onChange={event => setRenameNode(current => current ? { ...current, name: event.target.value } : current)} onPressEnter={saveNodeName} />
                    <p className="mt-2 text-xs" style={{ color: theme.node.muted }}>修改名称不改变图片内容或版本号。图片下载时会附带当前版本。</p>
                </Modal>
                {imageExport ? <Suspense fallback={null}><CanvasImagePdfDialog nodes={imageExport.nodes} defaultSelectedIds={imageExport.ids} defaultName={currentProject?.title || "图片集"} onClose={() => setImageExport(null)} /></Suspense> : null}
                {imageDownload?.projectId === projectId && nodes.some(node => node.id === imageDownload.node.id && node.metadata?.content === imageDownload.node.metadata?.content && node.metadata?.storageKey === imageDownload.node.metadata?.storageKey) ? <Suspense fallback={null}><CanvasImageDownloadDialog node={imageDownload.node} variants={imageDownload.variants} onClose={() => setImageDownload(null)} /></Suspense> : null}

                {infoNode ? (
                    <Suspense fallback={null}>
                        <CanvasNodeInfoModal node={infoNode} open onClose={() => setInfoNodeId(null)} />
                    </Suspense>
                ) : null}

                {localToolsEnabled && manualEditNode?.metadata?.content ? (
                    <Suspense fallback={null}>
                        <CanvasImageEditorDialog key={`${projectId}:${manualEditNode.id}`} node={manualEditNode} onClose={() => setManualEditNode(null)} onConfirm={saveManualImageEdit} />
                    </Suspense>
                ) : null}

                {localToolsEnabled && cropNode?.metadata?.content ? (
                    <Suspense fallback={null}>
                        <CanvasNodeCropDialog dataUrl={cropNode.metadata.content} open={Boolean(cropNode)} onClose={() => setCropNodeId(null)} onConfirm={(crop) => void cropImageNode(cropNode!, crop)} />
                    </Suspense>
                ) : null}

                {maskEditEnabled && maskEditNode?.metadata?.content ? (
                    <Suspense fallback={null}>
                        <CanvasNodeMaskEditDialog
                            dataUrl={maskEditNode.metadata.content}
                            open={Boolean(maskEditNode)}
                            config={effectiveConfig}
                            model={selectedMaskEditModel}
                            estimatedCredits={maskEditEstimate.configured ? maskEditEstimate.credits : undefined}
                            onModelChange={setMaskEditModel}
                            onClose={() => setMaskEditNodeId(null)}
                            onConfirm={(payload) => void maskEditImageNode(maskEditNode!, payload)}
                        />
                    </Suspense>
                ) : null}

                {localToolsEnabled && splitNode?.metadata?.content ? (
                    <Suspense fallback={null}>
                        <CanvasNodeSplitDialog dataUrl={splitNode.metadata.content} open={Boolean(splitNode)} onClose={() => setSplitNodeId(null)} onConfirm={(params) => void splitImageNode(splitNode!, params)} />
                    </Suspense>
                ) : null}

                {localToolsEnabled && upscaleNode?.metadata?.content ? (
                    <Suspense fallback={null}>
                        <CanvasNodeUpscaleDialog dataUrl={upscaleNode.metadata.content} open={Boolean(upscaleNode)} onClose={() => setUpscaleNodeId(null)} onConfirm={(params) => void upscaleImageNode(upscaleNode!, params)} />
                    </Suspense>
                ) : null}

                <Modal title="AI 超分" open={Boolean(superResolveNode?.metadata?.content)} centered footer={null} onCancel={() => setSuperResolveNodeId(null)}>
                    <div className="py-8 text-center text-base font-medium">暂未实现</div>
                </Modal>

                {angleEditEnabled && angleNode?.metadata?.content ? (
                    <Suspense fallback={null}>
                        <CanvasNodeAngleDialog dataUrl={angleNode.metadata.content} open={Boolean(angleNode)} onClose={() => setAngleNodeId(null)} onConfirm={(params) => void generateAngleNode(angleNode!, params)} />
                    </Suspense>
                ) : null}

                <Modal
                    title="图片详情"
                    open={Boolean(previewNode?.metadata?.content)}
                    centered
                    onCancel={() => setPreviewNodeId(null)}
                    footer={null}
                    width="auto"
                    styles={{ body: { padding: 0, display: "flex", justifyContent: "center", alignItems: "center", maxHeight: "80vh" } }}
                >
                    {previewNode?.metadata?.content ? <img src={previewNode.metadata.content} alt={previewNode.title || "图片"} style={{ maxWidth: "100%", maxHeight: "80vh", objectFit: "contain" }} /> : null}
                </Modal>

                <Modal
                    title="清空画布？"
                    open={clearConfirmOpen}
                    centered
                    onCancel={() => setClearConfirmOpen(false)}
                    footer={
                        <>
                            <Button onClick={() => setClearConfirmOpen(false)}>取消</Button>
                            <Button danger type="primary" onClick={clearCanvas}>
                                清空
                            </Button>
                        </>
                    }
                >
                    <p className="text-sm opacity-60">这会删除当前画布上的所有节点和连线。</p>
                </Modal>

                {assetPickerOpen ? (
                    <Suspense fallback={null}>
                        <AssetPickerModal open onInsert={handleAssetInsert} onClose={() => setAssetPickerOpen(false)} />
                    </Suspense>
                ) : null}
    </>;
});

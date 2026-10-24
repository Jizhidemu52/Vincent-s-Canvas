import { useState } from "react";
import type { CanvasNodeData } from "@/types/canvas";
import type { ServerAssetVariants } from "@/services/api/server-assets";

export function useCanvasDialogs() {
    const [compareImageIds, setCompareImageIds] = useState<string[] | null>(null);
    const [templateSourceId, setTemplateSourceId] = useState<string | null | undefined>(undefined);
    const [clearConfirmOpen, setClearConfirmOpen] = useState(false);
    const [assetPickerOpen, setAssetPickerOpen] = useState(false);
    const [infoNodeId, setInfoNodeId] = useState<string | null>(null);
    const [cropNodeId, setCropNodeId] = useState<string | null>(null);
    const [manualEditNode, setManualEditNode] = useState<CanvasNodeData | null>(null);
    const [imageExport, setImageExport] = useState<{ nodes: CanvasNodeData[]; ids: string[] } | null>(null);
    const [imageDownload, setImageDownload] = useState<{ projectId: string; node: CanvasNodeData; variants: ServerAssetVariants | null } | null>(null);
    const [renameNode, setRenameNode] = useState<{ id: string; name: string } | null>(null);
    const [renameGroup, setRenameGroup] = useState<{ id: string; name: string } | null>(null);
    const [maskEditNodeId, setMaskEditNodeId] = useState<string | null>(null);
    const [maskEditModel, setMaskEditModel] = useState("");
    const [splitNodeId, setSplitNodeId] = useState<string | null>(null);
    const [upscaleNodeId, setUpscaleNodeId] = useState<string | null>(null);
    const [superResolveNodeId, setSuperResolveNodeId] = useState<string | null>(null);
    const [angleNodeId, setAngleNodeId] = useState<string | null>(null);
    const [previewNodeId, setPreviewNodeId] = useState<string | null>(null);
    return { compareImageIds, setCompareImageIds, templateSourceId, setTemplateSourceId, clearConfirmOpen, setClearConfirmOpen, assetPickerOpen, setAssetPickerOpen, infoNodeId, setInfoNodeId, cropNodeId, setCropNodeId, manualEditNode, setManualEditNode, imageExport, setImageExport, imageDownload, setImageDownload, renameNode, setRenameNode, renameGroup, setRenameGroup, maskEditNodeId, setMaskEditNodeId, maskEditModel, setMaskEditModel, splitNodeId, setSplitNodeId, upscaleNodeId, setUpscaleNodeId, superResolveNodeId, setSuperResolveNodeId, angleNodeId, setAngleNodeId, previewNodeId, setPreviewNodeId };
}

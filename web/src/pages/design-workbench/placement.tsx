import { uiText, useUiText } from "@/lib/i18n";
import { useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { LocalDesignWorkbench } from "./local/host";
import type { LocalWorkbenchServices } from "./local/services";
import { mountPlacement } from "./local/placement/main.js";
import { placementAiAccess } from "./local/placement/ai-handoff";
import "./local/placement/placement.css";

export default function PatternPlacementPage() {
    useUiText();
    const navigate = useNavigate();
    const mount = useCallback((root: HTMLElement, services: LocalWorkbenchServices) => mountPlacement(root, {
        ...services,
        openAiEffect: async (project: Parameters<ReturnType<typeof placementAiAccess>["prepare"]>[0], composite: Blob, artwork: Blob) => {
            if (services.signal.aborted) return;
            const path = await placementAiAccess(services.signal).prepare(project, composite, artwork);
            if (!services.signal.aborted) navigate(path);
        },
    }), [navigate]);
    return <LocalDesignWorkbench moduleKey="pattern-placement" title={uiText("服装图案定位")} description={uiText("先分层定位、旋转与合成图案；完成后可带入图片编辑，生成 AI 面料融合效果。原图与定位工程保持不变。")} mount={mount} />;
}

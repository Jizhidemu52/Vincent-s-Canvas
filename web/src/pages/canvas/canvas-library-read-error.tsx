import { useState } from "react";
import { useUiText } from "@/lib/i18n";
import { flushCanvasCloudPersistence, useCanvasStore } from "@/stores/canvas/use-canvas-store";

export function CanvasLibraryReadError() {
    const t = useUiText();
    const [retrying, setRetrying] = useState(false);
    const retry = async () => {
        setRetrying(true);
        try {
            if (useCanvasStore.getState().libraryReadError) await useCanvasStore.persist.rehydrate();
            else await flushCanvasCloudPersistence();
        } finally { setRetrying(false); }
    };
    return <section role="alert" className="wb-surface wb-empty p-6">
        <h2 className="text-xl font-medium">{t("暂时无法读取画布列表")}</h2>
        <p className="my-3 text-sm text-muted-foreground">{t("请保留本机数据，重新读取已保存的画布。")}</p>
        <button type="button" className="underline" disabled={retrying} onClick={() => void retry().catch(() => undefined)}>{t("重新读取画布")}</button>
    </section>;
}

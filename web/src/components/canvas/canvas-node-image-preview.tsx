import { useUiText } from "@/lib/i18n";
import {lazy,Suspense,type ReactNode} from "react";
import type { CanvasNodeData } from "@/types/canvas";
import type { ImageThumbnailEdge } from "@/lib/canvas/canvas-image-thumbnail";
import { canvasImageRenderProps } from "@/lib/canvas/canvas-image-render-quality";
import { useCanvasImageThumbnail } from "./use-canvas-image-thumbnail";
import {useModuleEnabled} from "@/stores/use-module-store";
import {deploymentFeatures} from "@/lib/deployment-features";
const ProductCardChips=lazy(()=>import("../product-card-chips"));

function TryoutBadge({node}:{node:CanvasNodeData}){
    const t=useUiText(),enabled=useModuleEnabled("canvas-tryout"),meta=node.metadata,trace=meta?.tryout;
    if(!enabled||!trace?.tier)return null;
    const swap=meta?.imageTask?.tryoutSwap,error=meta?.errorDetails;
    const info=error|| (swap?t(swap.tier==="hd"?"正在出高清，保留快速档":"正在恢复快速档"):t(trace.tier==="hd"?"高清档":"快速档"));
    return <div role="status" className="pointer-events-none absolute inset-x-1 bottom-1 flex justify-center"><span className="max-w-full rounded-md bg-black/75 px-2 py-1 text-center text-xs text-white">{!error&&!swap&&(trace.color?.name||trace.material?.name)?(trace.color?.name||trace.material?.name)+" · ":""}{info}</span></div>;
}

/** Image loading is deferred until the canvas actually contains an image. */
export default function CanvasNodeImagePreview({ node, edge, placeholderColor, renderError }: {
    node: CanvasNodeData; edge: ImageThumbnailEdge | 0; placeholderColor: string; renderError: (retry: () => void) => ReactNode;
}) {
    const t = useUiText();
    const preview = useCanvasImageThumbnail(node, edge);
    const tryout=useModuleEnabled("canvas-tryout");
    const productSource=tryout&&deploymentFeatures.productCardsEnabled&&!node.metadata?.proposalBoard&&node.metadata?.tryout?.kind!=="wear"&&(node.metadata?.serverAssetId||node.metadata?.storageKey||node.metadata?.content);
    const fit = node.metadata?.freeResize ? "object-fill" : "object-contain";
    return <div className="relative h-full w-full overflow-hidden" style={{ background: placeholderColor }}>
        {preview.placeholderUrl ? <img src={preview.placeholderUrl} alt="" aria-hidden draggable={false} className={`pointer-events-none absolute inset-0 h-full w-full ${fit}`} /> : null}
        {preview.failed ? <div className="relative flex h-full w-full flex-col items-center justify-center gap-3" role="status">{renderError(preview.retry)}</div>
            : preview.url ? <img key={preview.key} src={preview.url} data-canvas-image-resolution={preview.edge || "original"} alt={node.title} draggable={false}
                data-tryout-source={!node.metadata?.proposalBoard&&node.metadata?.tryout?.kind!=="wear"?(node.metadata?.serverAssetId||node.metadata?.storageKey||(node.metadata?.content?.startsWith("/api/assets/")?node.metadata.content:undefined)):undefined}
                {...canvasImageRenderProps()} onError={preview.onError} onLoad={preview.onLoad} onDragStart={event => event.preventDefault()}
                style={{ opacity: preview.loaded ? 1 : 0 }}
                className={`cw-image-progressive pointer-events-none relative block h-full w-full select-none ${fit} ${preview.loaded && node.metadata?.sourceTaskId ? "cw-image-result-reveal" : ""}`} />
                : <div className="h-full w-full animate-pulse" style={{ background: placeholderColor }} aria-label={t("正在恢复图片预览")} />}
        {productSource?<Suspense fallback={null}><ProductCardChips key={productSource} source={productSource}/></Suspense>:null}
        {node.metadata?.tryout?.tier?<TryoutBadge node={node}/>:null}
    </div>;
}

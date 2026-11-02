import { useState } from "react";
import { createRoot } from "react-dom/client";
import { useCanvasImageThumbnail } from "../src/components/canvas/use-canvas-image-thumbnail";
import { useImagePreview } from "../src/hooks/use-image-preview";
import { CanvasPersistedMediaPreview } from "../src/components/canvas/canvas-persisted-media-preview";
import { useUserStore, type LocalUser } from "../src/stores/use-user-store";
import { deploymentFeatures } from "../src/lib/deployment-features";
import { CanvasNodeType, type CanvasNodeData } from "../src/types/canvas";
import type { ImageThumbnailEdge } from "../src/lib/canvas/canvas-image-thumbnail";

const id = "11111111-1111-4111-8111-111111111111", content = `/api/assets/${id}/content`;
const node: CanvasNodeData = { id: "image", type: CanvasNodeType.Image, title: "Preview", position: { x: 0, y: 0 }, width: 256, height: 192, metadata: { content, naturalWidth: 4096, naturalHeight: 3072 } };
deploymentFeatures.authenticationEnabled = true;
useUserStore.setState({ status: "authenticated", user: { id: "employee-a", role: "designer" } as LocalUser });

function NodePreview({ edge }: { edge: ImageThumbnailEdge | 0 }) {
    const preview = useCanvasImageThumbnail(node, edge);
    return <section data-testid="node" data-failed={preview.failed}>
        <button onClick={preview.retry}>retry</button>
        {preview.url ? <img src={preview.url} onLoad={preview.onLoad} onError={preview.onError} alt="node" width="256" /> : <span>waiting</span>}
    </section>;
}
function SimplePreview() {
    const url = useImagePreview({ dataUrl: content });
    return <section data-testid="simple">{url ? <img src={url} alt="simple" width="256" /> : <span>waiting</span>}</section>;
}
function Fixture() {
    const [edge, setEdge] = useState<ImageThumbnailEdge | 0>(256), [visible, setVisible] = useState(true);
    return <main>
        <button onClick={() => setEdge(0)}>original</button>
        <button onClick={() => setVisible(value => !value)}>toggle</button>
        <button onClick={() => useUserStore.setState({ status: "authenticated", user: { id: "employee-b", role: "designer" } as LocalUser })}>other account</button>
        {visible ? <><NodePreview edge={edge} /><SimplePreview /><section data-testid="persisted"><CanvasPersistedMediaPreview kind="image" url={content} className="preview" alt="persisted" /></section></> : null}
    </main>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);

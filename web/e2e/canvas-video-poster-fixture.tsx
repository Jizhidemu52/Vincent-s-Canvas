import { useState } from "react";
import { createRoot } from "react-dom/client";
import { CanvasVideoNodeContent } from "../src/components/canvas/canvas-video-node-content";
import { canvasThemes } from "../src/lib/canvas-theme";
import type { CanvasRenderQuality } from "../src/lib/canvas/canvas-render-quality";
import { CanvasNodeType, type CanvasNodeData } from "../src/types/canvas";
import "../src/styles/globals.css";

const assetId = '11111111-1111-4111-8111-111111111111';
const initial: CanvasNodeData = { id: 'fixture-video', title: 'Preview fixture', type: CanvasNodeType.Video, position: { x: 0, y: 0 }, width: 640, height: 360, metadata: { content: `/api/assets/${assetId}/content` } };
function Fixture() {
    const [quality, setQuality] = useState<CanvasRenderQuality>('full');
    const [local, setLocal] = useState('');
    const [visible, setVisible] = useState(true);
    const theme = canvasThemes.light;
    return <main style={{ padding: 30, background: theme.canvas.background, minHeight: '100vh' }}>
        <div style={{ display: 'flex', gap: 20, marginBottom: 30 }}>
            {(['full', 'moving', 'overview'] as const).map(value => <button key={value} onClick={() => setQuality(value)}>{value}</button>)}
            <button onClick={() => setVisible(value => !value)}>toggle</button>
            <button onClick={async () => setLocal(URL.createObjectURL(await (await fetch('/e2e/media/video.mp4')).blob()))}>local</button>
        </div>
        <div data-testid="video-host" style={{ width: 640, height: 360, borderRadius: 18 }}>
            {visible ? <CanvasVideoNodeContent node={local ? { ...initial, metadata: { content: local } } : initial} theme={theme} renderQuality={quality} /> : null}
        </div>
    </main>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);

import { useState } from "react";
import { createRoot } from "react-dom/client";
import { CanvasConfigComposer } from "../src/components/canvas/canvas-config-composer";
import type { NodeGenerationInput } from "../src/components/canvas/canvas-node-generation";
import { setUiLocale, useUiLocale } from "../src/lib/i18n";
import "../src/styles/globals.css";

function Fixture() {
    const [value, setValue] = useState("参考款：@[node:original]\n保留结构");
    const [state, setState] = useState<"pending" | "ready" | "deleted">("pending");
    const locale = useUiLocale();
    const input: NodeGenerationInput = { nodeId: "original", type: "image", title: "reference.png", ...(state === "pending" ? { pendingUpload: true } : { image: { id: "original", name: "reference.png", type: "image/png", dataUrl: "/e2e/media/reference.png" } }) };
    return <main style={{ maxWidth: 800, padding: 40 }}>
        <CanvasConfigComposer value={value} inputs={state === "deleted" ? [] : [input]} onChange={setValue} />
        <div onMouseDown={event => event.preventDefault()}>
            <button onClick={() => setState("ready")}>Receive original</button>
            <button onClick={() => setState("deleted")}>Delete original</button>
            <button onClick={() => setState("pending")}>Restore upload slot</button>
            <button onClick={() => void setUiLocale(locale === "en-US" ? "zh-CN" : "en-US")}>Switch language</button>
        </div>
        <output data-testid="source-draft">{value}</output>
    </main>;
}

createRoot(document.getElementById("root")!).render(<Fixture />);

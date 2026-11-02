import { StrictMode, useCallback, useState } from "react";
import { createRoot } from "react-dom/client";
import { useCanvasEditLock } from "../src/pages/canvas/use-canvas-edit-lock";

function LockFixture() {
    const query = new URLSearchParams(location.search);
    const [flushFailure, setFlushFailure] = useState(false);
    const [loads, setLoads] = useState(0);
    const [flushes, setFlushes] = useState(0);
    const flush = useCallback(async () => {
        setFlushes(value => value + 1);
        if (flushFailure) throw new Error("fixture save failure");
        await new Promise(resolve => setTimeout(resolve, 30));
    }, [flushFailure]);
    const load = useCallback(async () => {
        setLoads(value => value + 1);
        await new Promise(resolve => setTimeout(resolve, 30));
        if (query.get("failLoad") === "true") throw new Error("fixture load failure");
    }, [query.get("failLoad")]);
    const lock = useCanvasEditLock(query.get("owner") || "test-owner", query.get("project") || "test-project", flush, true, load);
    return <div>
        <output data-testid="lock-state" data-state={lock.status}>{lock.status}</output>
        <output data-testid="loads">{loads}</output><output data-testid="flushes">{flushes}</output>
        <button onClick={lock.requestEditing}>request</button>
        <button onClick={() => setFlushFailure(value => !value)}>toggle failure</button>
        <span>{lock.error}</span>
    </div>;
}
createRoot(document.getElementById("root")!).render(<StrictMode><LockFixture /></StrictMode>);

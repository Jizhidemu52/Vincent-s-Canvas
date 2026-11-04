import { StrictMode, useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { useCanvasEditLock } from "../src/pages/canvas/use-canvas-edit-lock";

declare global {
    interface Window {
        __lockFixture: { canWrite: () => boolean; ensureWritable: () => Promise<boolean>; write: () => boolean; status: string };
        __lockObservations: { status: string; error?: string }[];
        __unmountLockFixture: () => void;
    }
}

function LockFixture() {
    const query = new URLSearchParams(location.search);
    const [flushFailure, setFlushFailure] = useState(false);
    const [loads, setLoads] = useState(0);
    const [flushes, setFlushes] = useState(0);
    const [draft, setDraft] = useState("");
    const [writes, setWrites] = useState(0);
    const flush = useCallback(async () => {
        setFlushes(value => value + 1);
        if (flushFailure) throw new Error("fixture save failure");
        await new Promise(resolve => setTimeout(resolve, 30));
    }, [flushFailure]);
    const load = useCallback(async () => {
        setLoads(value => value + 1);
        await new Promise(resolve => setTimeout(resolve, 30));
        if (query.get("failLoad") === "true") throw new Error("fixture load failure");
        setDraft("latest saved draft");
    }, [query.get("failLoad")]);
    const lock = useCanvasEditLock(query.get("owner") || "test-owner", query.get("project") || "test-project", flush, true, load);
    const write = useCallback(() => {
        if (!lock.canWrite()) return false;
        setWrites(value => value + 1);
        return true;
    }, [lock.canWrite]);
    useEffect(() => {
        window.__lockFixture = { canWrite: lock.canWrite, ensureWritable: lock.ensureWritable, write, status: lock.status };
        (window.__lockObservations ??= []).push({ status: lock.status, error: lock.error });
    }, [lock.canWrite, lock.ensureWritable, lock.status, lock.error, write]);
    return <div>
        <output data-testid="lock-state" data-state={lock.status}>{lock.status}</output>
        <output data-testid="loads">{loads}</output><output data-testid="flushes">{flushes}</output>
        <output data-testid="writes">{writes}</output>
        <input aria-label="draft" value={draft} onChange={event => { if (lock.canWrite()) setDraft(event.target.value); }} />
        <button onClick={write}>write</button>
        <button onClick={lock.requestEditing}>request</button>
        <button onClick={() => setFlushFailure(value => !value)}>toggle failure</button>
        <span>{lock.error}</span>
    </div>;
}
const root = createRoot(document.getElementById("root")!);
window.__unmountLockFixture = () => root.unmount();
root.render(<StrictMode><LockFixture /></StrictMode>);

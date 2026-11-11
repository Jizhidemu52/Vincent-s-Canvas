import React, { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { LayerStudioEditor, type LayerStudioEditDocument } from "../src/pages/layer-studio/layer-editor";
import type { LayerStudioResultDocument } from "../../shared/layer-studio";
import { useUserStore } from "../src/stores/use-user-store";
import { useThemeStore } from "../src/stores/use-theme-store";
import { deploymentFeatures } from "../src/lib/deployment-features";
import "../src/styles/globals.css";

const assets = new Map<string, Blob>();
const digests = new Map<string, string>();
for (const [id, width, height, color] of [["base", 64, 64, "#ff0000"], ["blue", 8, 8, "#0000ff"], ["green", 4, 4, "#00ff00"]] as const) {
    const canvas = document.createElement("canvas"); canvas.width = width; canvas.height = height;
    const context = canvas.getContext("2d")!; context.fillStyle = color; context.fillRect(0, 0, width, height);
    const blob = await new Promise<Blob>(resolve => canvas.toBlob(blob => resolve(blob!), "image/png"));
    assets.set(id, blob);
    digests.set(id, [...new Uint8Array(await crypto.subtle.digest("SHA-256", await blob.arrayBuffer()))].map(byte => byte.toString(16).padStart(2, "0")).join(""));
}
const requests: Array<{ path: string; headers: Record<string, string>; method: string }> = [];
const originalFetch = window.fetch.bind(window);
let fail = false;
window.fetch = async (input, init) => {
    const path = typeof input === "string" ? input : input instanceof Request ? input.url : String(input);
    if (path.startsWith("/api/assets/")) {
        requests.push({ path, headers: Object.fromEntries(new Headers(init?.headers)), method: init?.method || "GET" });
        const id = path.split("/")[3]; const blob = assets.get(id);
        if (fail || !blob) return new Response("missing", { status: 503 });
        return new Response(blob, { headers: { "Content-Type": "image/png" } });
    }
    return originalFetch(input, init);
};
const urls = new Set<string>();
const createUrl = URL.createObjectURL.bind(URL), revokeUrl = URL.revokeObjectURL.bind(URL);
URL.createObjectURL = blob => { const url = createUrl(blob); urls.add(url); return url; };
URL.revokeObjectURL = url => { urls.delete(url); revokeUrl(url); };
Object.assign(deploymentFeatures, { authenticationEnabled: true, creditsEnabled: true });
const user = { id: "synthetic-owner-a", username: "synthetic", name: "合成测试员工", role: "designer", status: "active", avatarUrl: "" };
useUserStore.setState({ status: "authenticated", user: user as never });
useThemeStore.getState().setTheme("light");
const fixture: LayerStudioResultDocument = { version: 1, taskId: "synthetic-composition", mode: "decompose", status: "ready", expectedOutputCount: 3, items: [
    { index: 0, groupIndex: 0, urlIndex: 0, role: "base", state: "saved", assetId: "base", contentUrl: "/api/assets/base/content", sha256: digests.get("base"), width: 64, height: 64, name: "红色底图" },
    { index: 1, groupIndex: 0, urlIndex: 1, role: "layer", state: "saved", assetId: "blue", contentUrl: "/api/assets/blue/content", sha256: digests.get("blue"), width: 8, height: 8, name: "蓝色方块", boundingBox: { absolute: [16, 16, 48, 48] }, textRecognition: { text: "<script>不执行</script>", lines: [{ runs: [{ text: "合成测试", style: { bold: true, similarFontFamily: "无真实字体证明" } }] }] } },
    { index: 2, groupIndex: 0, urlIndex: 2, role: "layer", state: "saved", assetId: "green", contentUrl: "/api/assets/green/content", sha256: digests.get("green"), width: 4, height: 4, name: "绿色方块", boundingBox: { normalized: [375, 375, 625, 625] } },
] };
const storageKey = "layer-editor-synthetic-proof";
function Fixture() {
    const [result, setResult] = useState(fixture);
    const [value, setValue] = useState<LayerStudioEditDocument | undefined>(() => {
        try { return JSON.parse(localStorage.getItem(storageKey) || "null") || undefined; } catch { return undefined; }
    });
    const change = (next: LayerStudioEditDocument) => { setValue(next); localStorage.setItem(storageKey, JSON.stringify(next)); };
    Object.assign(window, { layerEditorFixture: { requests, urls, digests: Object.fromEntries(digests), value,
        partial: () => setResult({ ...fixture, status: "partial", items: fixture.items.map(item => item.index === 2 ? { ...item, state: "pending", contentUrl: undefined, assetId: undefined } : item) }),
        missingPosition: () => setResult({ ...fixture, items: fixture.items.map(item => ({ ...item, boundingBox: undefined })) }),
        missingDimensions: () => setResult({ ...fixture, items: fixture.items.map(item => ({ ...item, width: undefined, height: undefined })) }),
        multipleGroups: () => setResult({ ...fixture, expectedOutputCount: 5, items: [...fixture.items,
            { ...fixture.items[1], index: 3, groupIndex: 1, urlIndex: 0, role: "base", name: "第二组底图", boundingBox: undefined },
            { ...fixture.items[2], index: 4, groupIndex: 1, urlIndex: 1, name: "第二组图层", boundingBox: undefined }] }),
        failRead: () => { fail = true; setResult({ ...fixture, items: fixture.items.map(item => ({ ...item, sha256: undefined })) }); },
        switchOwner: () => useUserStore.setState({ user: { ...user, id: "synthetic-owner-b" } as never }),
        dark: () => useThemeStore.getState().setTheme("dark"),
    } });
    return <main style={{ maxWidth: 1280, margin: "20px auto", padding: 12, fontFamily: "Arial, Microsoft YaHei, sans-serif" }}><h1 style={{ fontSize: 16, marginBottom: 12 }}>本地合成验证 · 非模型实测</h1><LayerStudioEditor document={result} value={value} onChange={change} /></main>;
}
createRoot(document.getElementById("root")!).render(<StrictMode><Fixture /></StrictMode>);

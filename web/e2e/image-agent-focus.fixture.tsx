import { useState } from "react";
import { createRoot } from "react-dom/client";
import { ImageAgentFocus, type ImageAgentFocusImage } from "../src/components/image-agent-focus";
import { useThemeStore } from "../src/stores/use-theme-store";
import { setUiLocale } from "../src/lib/i18n";
import { canvasThemes } from "../src/lib/canvas-theme";
import "../src/styles/globals.css";

const asset = (value: number) => `/api/assets/${String(value).padStart(8, "0")}-1111-4111-8111-111111111111/content`;
const initial: ImageAgentFocusImage[] = [
    { id: "original", label: "原图1", kind: "upload", name: "原始针织帽参考.png", dataUrl: asset(1) },
    { id: "v2", label: "图1", kind: "generated", parentId: "original", dataUrl: asset(2) },
    { id: "v3", label: "图2", kind: "generated", parentId: "v2", dataUrl: asset(3), note: { summary: "保留原有针织结构，帽身改成淡蓝色，并调整正面图案的位置。This_long_word_checks_narrow_panel_wrapping_without_changing_any_user_content.", keep: ["花边宽度不变", "原版比例不变"] } },
    { id: "other", label: "原图2", kind: "upload", dataUrl: asset(4) },
    { id: "unavailable", label: "图3", kind: "generated", unavailableReason: "源文件已移除" },
];
function Fixture() {
    const [images, setImages] = useState(initial);
    const [focus, setFocus] = useState<string | undefined>("v3");
    const [fresh, setFresh] = useState(false), [disabled, setDisabled] = useState(false), [narrow, setNarrow] = useState(false), [mounted, setMounted] = useState(true);
    const themeName = useThemeStore(state => state.theme), theme = canvasThemes[themeName];
    return <main style={{ padding: 24, minHeight: "100vh", background: theme.canvas.background, color: theme.node.text }}>
        <nav className="mb-8 flex flex-wrap gap-3 text-sm">
            <button onClick={() => useThemeStore.getState().setTheme(themeName === "light" ? "dark" : "light")}>theme</button>
            <button onClick={() => setNarrow(value => !value)}>width</button>
            <button onClick={() => void setUiLocale("en-US")}>English</button>
            <button onClick={() => setImages(items => items.filter(image => image.id !== "original"))}>remove original</button>
            <button onClick={() => setDisabled(value => !value)}>busy</button>
            <button onClick={() => setMounted(value => !value)}>remount</button>
            <button onClick={() => { setFocus(undefined); setFresh(false); }}>clear focus</button>
        </nav>
        <div data-testid="panel" style={{ width: narrow ? 240 : 360, maxWidth: "100%" }}>
            {mounted ? <ImageAgentFocus images={images} focusId={focus} locked={Boolean(focus)} newCreation={fresh} referenceCount={2} disabled={disabled}
                onSelect={id => { setFocus(id); setFresh(false); }} onNewCreation={() => setFresh(true)} /> : null}
        </div>
        <output data-testid="selection">{fresh ? "new" : focus || "none"}</output>
    </main>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);

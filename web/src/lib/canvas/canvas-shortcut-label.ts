export function canvasShortcutLabel(value: string, platform = typeof navigator === "undefined" ? "" : navigator.platform) {
    return value.replaceAll("Ctrl / Cmd", /Mac|iPhone|iPad|iPod/i.test(platform) ? "⌘" : "Ctrl");
}

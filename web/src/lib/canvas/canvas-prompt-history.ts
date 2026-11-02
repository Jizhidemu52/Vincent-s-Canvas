import { createWorkspaceStorage } from "@/lib/workspace-storage";

export function mergeCanvasPromptHistory(existing: readonly string[], prompt: string) {
    const text = prompt.trim();
    return text ? [text, ...existing.filter(item => item !== text)].slice(0, 50) : [...existing].slice(0, 50);
}
export async function getRecentCanvasPrompts() {
    const storage = createWorkspaceStorage("canvas_prompt_history");
    await pendingWrite;
    return await storage.getItem<string[]>("recent") || [];
}
let pendingWrite: Promise<void> = Promise.resolve();
export function rememberCanvasPrompt(prompt: string) {
    const storage = createWorkspaceStorage("canvas_prompt_history");
    const write = pendingWrite.then(async () => {
        const existing = await storage.getItem<string[]>("recent") || [];
        await storage.setItem("recent", mergeCanvasPromptHistory(existing, prompt));
    });
    pendingWrite = write.catch(() => undefined);
    return write;
}

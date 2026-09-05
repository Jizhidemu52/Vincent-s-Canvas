import type { AgentGenerationSettings } from "@/lib/agent-direct-generation";
import type { AiConfig } from "@/stores/use-config-store";
import type { CanvasAgentOp } from "./canvas-agent-ops";

export function onlineAgentConfig(config: AiConfig, settings: AgentGenerationSettings): AiConfig {
    return {
        ...config,
        imageModel: settings.imageModel,
        videoModel: settings.videoModel,
        size: settings.size,
        quality: settings.quality,
        count: settings.imageCount,
        canvasImageCount: settings.imageCount,
        videoSeconds: settings.videoSeconds,
        vquality: settings.videoQuality,
        videoGenerateAudio: settings.videoGenerateAudio ?? config.videoGenerateAudio,
    };
}

export function onlineAgentMediaSettings(settings: AgentGenerationSettings, mode: "image" | "video", input: Record<string, unknown>): AgentGenerationSettings {
    const option = (name: string, fallback: string) => typeof input[name] === "string" && input[name].trim() ? input[name] : fallback;
    return {
        ...settings,
        mode,
        imageModel: mode === "image" ? option("model", settings.imageModel) : settings.imageModel,
        videoModel: mode === "video" ? option("model", settings.videoModel) : settings.videoModel,
        size: option("size", settings.size),
        quality: option("quality", settings.quality),
        imageCount: typeof input.count === "number" && Number.isFinite(input.count) ? String(input.count) : settings.imageCount,
        videoSeconds: option("seconds", settings.videoSeconds),
        videoQuality: option("vquality", settings.videoQuality),
        videoGenerateAudio: option("generateAudio", settings.videoGenerateAudio ?? "false"),
    };
}

// run_generation is a real asynchronous action, never a fire-and-forget canvas mutation.
export async function executeOnlineAgentOperations<Result>(
    ops: CanvasAgentOp[],
    apply: (mutations: CanvasAgentOp[]) => unknown,
    generate: (operation: Extract<CanvasAgentOp, { type: "run_generation" }>) => Promise<Result>,
) {
    const generated: Result[] = [];
    let mutations: CanvasAgentOp[] = [];
    for (const op of ops) {
        if (op.type !== "run_generation") {
            mutations.push(op);
            continue;
        }
        if (mutations.length) apply(mutations);
        mutations = [];
        generated.push(await generate(op));
    }
    if (mutations.length) apply(mutations);
    return generated;
}

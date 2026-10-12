import type { CanvasProjectMetadata } from "@/lib/canvas/canvas-project-metadata-sync";

export async function syncProjectMetadata(ownerId: string, project: CanvasProjectMetadata, signal: AbortSignal): Promise<void> {
    const response = await fetch("/api/projects/sync", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json", "X-Canvas-Owner-Id": ownerId },
        signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
        body: JSON.stringify({ externalId: project.id, name: project.title }),
    });
    const body = await response.json();
    if (!response.ok) throw new Error(body.message || "项目名称同步失败");
    if (body.project?.externalId !== project.id || body.project?.name !== project.title) throw new Error("项目名称同步结果不匹配");
}

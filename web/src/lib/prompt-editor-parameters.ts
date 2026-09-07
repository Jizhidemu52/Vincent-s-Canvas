export function mergePromptEditorParameters(original: Record<string, unknown> | undefined, values: { size?: string; quality?: string; quantity?: number }) {
    const parameters = { ...original };
    // Preserve parameters not represented by this editor (video mode, duration, resolution, etc.).
    if (values.size?.trim()) parameters.size = values.size.trim(); else delete parameters.size;
    if (values.quality) parameters.quality = values.quality; else delete parameters.quality;
    parameters.quantity = values.quantity ?? 1;
    if ("count" in parameters) parameters.count = parameters.quantity;
    return parameters;
}

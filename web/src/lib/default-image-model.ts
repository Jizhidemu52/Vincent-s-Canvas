export const DEFAULT_IMAGE_MODEL = "aplmart-gpt2";

type ImageModelIdentity = { id?: string; modelId: string; name?: string; publicName?: string };

/** Resolve the provider-specific public alias, never the ambiguous upstream GPT-2 ID. */
export function preferredImageModel<T extends ImageModelIdentity>(models: readonly T[], preferred: readonly (string | undefined)[] = []): T | undefined {
    const find = (value?: string) => {
        if (!value) return undefined;
        const separator = value.indexOf("::");
        const normalized = separator < 0 ? value : value.slice(separator + 2);
        return models.find(model => [model.id, model.modelId, model.name, model.publicName].includes(normalized));
    };
    return preferred.map(find).find(Boolean) || find(DEFAULT_IMAGE_MODEL) || models[0];
}

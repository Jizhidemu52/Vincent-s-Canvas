import type { ToolKey } from "../../shared/feature-catalog";

/** Existing slots remain independent. New slots may reuse their closest configured image model. */
const defaults: Partial<Record<ToolKey, readonly ToolKey[]>> = {
  "creative-series-extension": ["creative-local-restyle", "image-edit"],
  "creative-bestseller-proposal": ["creative-local-restyle", "image-edit"],
  "creative-detail-to-style": ["creative-local-restyle", "image-edit"],
  "creative-fabric-to-style": ["creative-local-restyle", "image-edit"],
  "creative-reference-to-style": ["creative-local-restyle", "image-edit"],
  "creative-style-fusion": ["creative-local-restyle", "image-edit"],
  "creative-outfit-design": ["creative-local-restyle", "image-edit"],
  "creative-apply-pattern": ["creative-pattern-craft", "image-edit"],
  "creative-pattern-fill": ["creative-local-restyle", "image-edit"],
  "creative-fabric-change": ["creative-local-restyle", "image-edit"],
  "creative-remove-decoration": ["creative-local-restyle", "image-edit"],
  "creative-sketch-to-style": ["creative-style-to-sketch", "image-edit"],
  "creative-pattern-create": ["creative-text-to-style", "image"],
  "creative-pattern-fusion": ["creative-pattern-craft", "image-edit"],
  "creative-seamless-pattern": ["creative-pattern-extract", "image-edit"],
  "creative-pattern-layers": ["creative-pattern-extract", "image-edit"],
};

type Binding = { toolKey: string; modelConfigId?: unknown; configurationVersion?: unknown; useDefaultModel?: unknown };
const modelFields = [
  "modelName", "modelId", "modelCreditCost", "modelRmbCost", "modelEnabled",
  "providerId", "providerName", "protocol", "baseUrl", "providerEnabled", "hasCredentials",
  "workflowConfigId", "workflowName", "workflowEnabled",
] as const;

/** An explicit admin save, including clearing a binding, ends first-run inheritance. */
export function creativeModelDefaultSources(tool: Binding, initialVersion = 1): readonly ToolKey[] {
  if (tool.modelConfigId || tool.useDefaultModel === false || Number(tool.configurationVersion ?? 0) > initialVersion) return [];
  return defaults[tool.toolKey as ToolKey] ?? [];
}

export function applyCreativeModelDefaults<T extends Binding>(tools: T[], initialVersion = 1): T[] {
  return tools.map(tool => {
    const source = creativeModelDefaultSources(tool, initialVersion)
      .map(key => tools.find(candidate => candidate.toolKey === key))
      .find(candidate => candidate?.modelConfigId) as (T & Record<string, unknown>) | undefined;
    if (!source) return tool;
    const inherited = Object.fromEntries(modelFields.filter(field => field in source).map(field => [field, source[field]]));
    return { ...tool, ...inherited, modelConfigId: source.modelConfigId, modelDefaultSourceToolKey: source.toolKey };
  });
}

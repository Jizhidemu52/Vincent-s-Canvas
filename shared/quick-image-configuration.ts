import type { QuickImageAction } from "./quick-image-tools";

/** Administrator-only configuration. Never included in the public business config. */
export type QuickImageConfigurationInput = {
  modelConfigId: string;
  prompt: string;
  parameters: Record<string, unknown>;
};

export type AdminQuickImageConfiguration = {
  action: QuickImageAction;
  modelConfigId: string | null;
  modelId: string | null;
  modelName: string | null;
  prompt: string;
  parameters: Record<string, unknown>;
  configurationVersion: number;
  isDefault: boolean;
};

export type QuickImageEligibleModel = {
  id: string;
  name: string;
  modelId: string;
  providerName: string;
  protocol: string;
  capabilities: string[];
};

export type QuickImageConfigurationUpdate = QuickImageConfigurationInput & { expectedVersion: number };
export type QuickImageConfigurationTest = {
  requestId: string;
  sourceUrl: string;
  configuration: QuickImageConfigurationInput;
};

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { moduleKeys, toolDefinitions } from "../../shared/feature-catalog";
import { applyCreativeModelDefaults, creativeModelDefaultSources } from "../src/creative-model-policy";

describe("creative model defaults", () => {
  const tools = [
    { toolKey: "creative-local-restyle", modelConfigId: "related-model", configurationVersion: 8, enabled: false, creditCostOverride: 80, modelName: "Related model" },
    { toolKey: "image-edit", modelConfigId: "generic-model", configurationVersion: 3, enabled: true, creditCostOverride: 5 },
    { toolKey: "creative-fabric-change", modelConfigId: null, configurationVersion: 1, enabled: true, creditCostOverride: 0 },
  ];
  test("inherits only model fields while its own switch, price and version stay independent", () => {
    const result = applyCreativeModelDefaults(tools);
    expect(result[2]).toMatchObject({ modelConfigId: "related-model", modelName: "Related model", enabled: true, creditCostOverride: 0, configurationVersion: 1, modelDefaultSourceToolKey: "creative-local-restyle" });
    expect(result[0]).toBe(tools[0]);
    expect(tools[2]!.modelConfigId).toBeNull();
    expect(applyCreativeModelDefaults(tools.slice(1))[1]!.modelConfigId).toBe("generic-model");
  });
  test("explicit configuration and explicit clearing always win", () => {
    const fresh = tools[2]!;
    for (const change of [{ modelConfigId: "own-model" }, { configurationVersion: 2 }, { useDefaultModel: false }]) {
      const selected = { ...fresh, ...change };
      expect(applyCreativeModelDefaults([tools[0]!, selected])[1]).toBe(selected);
    }
    expect(creativeModelDefaultSources({ ...fresh, configurationVersion: 1 }, 0)).toEqual([]);
    expect(creativeModelDefaultSources({ ...fresh, configurationVersion: 0 }, 0)).toHaveLength(2);
  });
  test("no existing image tool acquires new inheritance and missing sources retain choice", () => {
    for (const toolKey of ["creative-pattern-extract", "creative-local-restyle", "canvas-edit", "image-edit"]) {
      expect(creativeModelDefaultSources({ toolKey, modelConfigId: null })).toEqual([]);
    }
    expect(applyCreativeModelDefaults([tools[2]!])[0]!.modelConfigId).toBeNull();
    expect(creativeModelDefaultSources({ toolKey: "creative-pattern-create" })).toEqual(["creative-text-to-style", "image"]);
    expect(creativeModelDefaultSources({ toolKey: "creative-seamless-pattern" })).not.toContain("seamless-stitch");
  });
  test("migration checks exactly match the shared tool and module contracts", () => {
    const sql = readFileSync(new URL("../src/migrations/039_creative_design_tools.sql", import.meta.url), "utf8");
    const entries = (key: string) => [...sql.match(new RegExp(`CHECK \\(${key} IN \\(([\\s\\S]*?)\\)\\)`))![1]!.matchAll(/'([^']+)'/g)].map(match => match[1]);
    expect(entries("tool_key").sort()).toEqual(toolDefinitions.map(tool => tool.toolKey).sort());
    expect(entries("module_key").sort()).toEqual([...moduleKeys].sort());
    expect(moduleKeys.filter(key => key.endsWith("-vectorization"))).toHaveLength(2);
    expect(toolDefinitions.some(tool => String(tool.toolKey).endsWith("-vectorization"))).toBe(false);
    expect(sql).not.toMatch(/UPDATE\s+(?:model_configs|providers|pricing_rule_versions|tool_api_configurations)/);
  });
});

import { afterEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { imageModelDisplayName } from "@/lib/model-display";
import { defaultConfig, modelOptionLabel } from "@/stores/use-config-store";
import { useBusinessConfigStore } from "@/stores/use-business-config-store";
import { useUserStore } from "@/stores/use-user-store";

const sourceText = readFileSync(new URL("../src/pages/image/index.tsx", import.meta.url), "utf8");
const source = ts.createSourceFile("image.tsx", sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let summaryExpression: ts.Expression | undefined;
function visit(node: ts.Node) {
    if (ts.isJsxExpression(node) && node.expression && node.expression.getText(source).includes("modelOptionLabel(effectiveConfig, model)")) summaryExpression = node.expression;
    ts.forEachChild(node, visit);
}
visit(source);
if (!summaryExpression) throw new Error("Image workspace model summary expression was not found");
// Evaluate the production summary expression, not a second copy of its label rule.
const summary = new Function("modelOptionLabel", "imageModelDisplayName", "effectiveConfig", "model", "businessModels", "user", `return (${summaryExpression.getText(source)});`);
const savedBusiness = useBusinessConfigStore.getState();
const savedUser = useUserStore.getState();
afterEach(() => { useBusinessConfigStore.setState(savedBusiness); useUserStore.setState(savedUser); });
const model = { id: "11111111-1111-4111-8111-111111111111", modelId: "mai-image-2.6-flash", name: "aplmart-mai2.6-flash", publicName: "MAI Image 2.6 Flash", capabilities: ["generate", "edit", "batch"], creditCost: 0, rmbCost: 0 };

test.each(["super_admin", "department_admin", "designer"] as const)("%s image summary resolves the configured MAI UUID without changing its request value", role => {
    const user = { ...savedUser.user, id: "summary-test", role };
    useBusinessConfigStore.setState({ models: [model] });
    useUserStore.setState({ user: user as never });
    const config = { ...defaultConfig, model: model.id, imageModel: model.id };
    expect(summary(modelOptionLabel, imageModelDisplayName, config, model.id, [model], user)).toBe(role === "designer" ? model.publicName : model.name);
    expect(config.model).toBe(model.id);
    expect(config.imageModel).toBe(model.id);
    expect(useBusinessConfigStore.getState().models).toEqual([model]);
});

test("image summary keeps a local model's channel label when no server mapping exists", () => {
    const user = { ...savedUser.user, id: "summary-test", role: "super_admin" };
    useBusinessConfigStore.setState({ models: [] });
    useUserStore.setState({ user: user as never });
    const config = { ...defaultConfig, channels: [{ id: "local", name: "Local channel", models: ["custom-image"], baseUrl: "", apiKey: "" }] };
    expect(summary(modelOptionLabel, imageModelDisplayName, config, "local::custom-image", [], user)).toBe("custom-image（Local channel）");
});

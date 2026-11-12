import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AdminDetails } from "../src/pages/admin/admin-labels";
import { formatNonFinancialJson, formatNonFinancialPreview, isFinancialAuditAction, omitFinancialFields } from "../src/lib/financial-presentation";

test("display projection removes only known finance keys without mutating source or free text", () => {
    const input = { totalRmbCost: 1.5, count: 3, prompt: "设计一张价格为99元的吊牌，cost不删", capabilities: { costume: true, lowCostDesign: true }, parameters: { width: 512, credits: 9 }, items: [{ creditBalance: 100, status: "active" }] };
    const original = structuredClone(input);
    expect(omitFinancialFields(input)).toEqual({ count: 3, prompt: input.prompt, capabilities: input.capabilities, parameters: { width: 512 }, items: [{ status: "active" }] });
    expect(input).toEqual(original);
    expect(formatNonFinancialJson(input)).not.toContain('"totalRmbCost"');
    expect(formatNonFinancialPreview(JSON.stringify(input))).toBe(formatNonFinancialJson(input));
    expect(formatNonFinancialPreview("文字报告：讨论面料成本和价格，不应修改用户内容")).toBe("文字报告：讨论面料成本和价格，不应修改用户内容");
});

test("only known financial audit actions are hidden", () => {
    expect(isFinancialAuditAction("account.monthly_credit_updated")).toBe(true);
    expect(isFinancialAuditAction("price.published")).toBe(true);
    expect(isFinancialAuditAction("price.draft_created")).toBe(true);
    expect(isFinancialAuditAction("credits.policy_changed")).toBe(true);
    expect(isFinancialAuditAction("layer_studio.price_updated")).toBe(true);
    for (const action of ["group.credit_policy_updated", "group.credit_requested", "group.credit_request_rejected", "group.credit_request_approved", "group.credit_contributed"]) expect(isFinancialAuditAction(action)).toBe(true);
    expect(isFinancialAuditAction("group.member_added")).toBe(false);
    expect(isFinancialAuditAction("account.updated")).toBe(false);
    expect(isFinancialAuditAction("model.updated")).toBe(false);
});

test("mixed tool configuration audit details hide exact override values and preserve zero nonfinancial controls", () => {
    const detail = { modelConfigId: "model-1", enabled: false, creditCostOverride: 0, rmbCostOverride: null, creditCost: 12, configurationVersion: 0, allowRawPrompt: true, prompt: "积分99和rmbCostOverride是设计文字，不能删" };
    expect(omitFinancialFields(detail)).toEqual({ modelConfigId: "model-1", enabled: false, configurationVersion: 0, allowRawPrompt: true, prompt: detail.prompt });
    expect(detail).toMatchObject({ creditCostOverride: 0, rmbCostOverride: null, creditCost: 12 });
});

test("audit changed-field lists omit known financial names but preserve identical words in user prose", () => {
    const html = renderToStaticMarkup(createElement(AdminDetails, { value: { fields: ["name", "creditCost", "rmbCost", "enabled"], prompt: "rmbCost是吊牌文字" }, audit: true }));
    expect(html).not.toContain(">creditCost<");
    expect(html).not.toContain("人民币成本");
    expect(html).toContain("启用状态");
    expect(html).toContain("rmbCost是吊牌文字");
});

test("non-audit user parameter field arrays are not interpreted as changed configuration keys", () => {
    const html = renderToStaticMarkup(createElement(AdminDetails, { value: { fields: ["creditCost", "rmbCost"] } }));
    expect(html).toContain(">creditCost<");
    expect(html).toContain("人民币成本");
});

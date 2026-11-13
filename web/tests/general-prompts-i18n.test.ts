import { afterEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { generalPromptTemplates } from "../../shared/general-prompt-templates";
import { generalPromptOptions, promptLibrarySourceLabels } from "../src/components/prompts/prompt-library-data";
import { getUiLocale, setUiLocale, setUiPathname } from "../src/lib/i18n";
import english from "../src/lib/i18n/en";
import { englishGeneralPromptVariants } from "../src/lib/i18n/en-general-prompts";
import { generalPromptDestination, generalPromptSnapshot, getLocalizedGeneralPrompts, matchingGeneralPrompts } from "../src/pages/prompts/general-prompts";

afterEach(async () => { setUiPathname("/prompts"); await setUiLocale("zh-CN"); });

test("all 24 built-ins have complete English variants with unchanged identity, sources and targets", async () => {
    const original = JSON.stringify(generalPromptTemplates);
    expect(generalPromptTemplates).toHaveLength(24);
    expect(Object.keys(englishGeneralPromptVariants).sort()).toEqual(generalPromptTemplates.map(item => item.id).sort());
    await setUiLocale("en-US");
    const localized = getLocalizedGeneralPrompts();
    expect(localized).toHaveLength(24);
    for (const [index, item] of localized.entries()) {
        const source = generalPromptTemplates[index];
        expect(item.id).toBe(source.id);
        expect(item.targetTool).toBe(source.targetTool);
        expect(item.sources.map(reference => reference.url)).toEqual(source.sources.map(reference => reference.url));
        expect(item.tags).toHaveLength(source.tags.length);
        for (const text of [item.title, item.category, item.prompt, item.notes, ...item.tags, ...item.sources.map(reference => reference.title)]) {
            expect(text.trim()).not.toBe("");
            expect(text, item.id).not.toMatch(/\p{Script=Han}/u);
        }
        // Preserve the authored instruction structure, not just an English summary.
        expect(item.prompt.split("\n\n")).toHaveLength(source.prompt.split("\n\n").length);
        expect([...item.prompt.matchAll(/\[(TARGET|CHANGE|LOCK|FABRIC DETAIL|OUTPUT|EXCLUDE)\]/g)].map(match => match[1]))
            .toEqual([...source.prompt.matchAll(/【([^】]+)】/g)].map(match => match[1]));
    }
    expect(JSON.stringify(generalPromptTemplates)).toBe(original);
    await setUiLocale("zh-CN");
    expect(getLocalizedGeneralPrompts()).toBe(generalPromptTemplates);
    expect(JSON.stringify(getLocalizedGeneralPrompts())).toBe(original);
});

test("English catalog search, picker, URL fill and personal snapshot use the same full prompt", async () => {
    await setUiLocale("en-US");
    const localized = getLocalizedGeneralPrompts();
    for (const item of localized) {
        const option = generalPromptOptions(item.title, [], "全部").find(value => value.id === `general:${item.id}`)!;
        expect(option).toBeDefined();
        expect(option.prompt).toBe(item.prompt);
        expect(option.templateId).toBeNull();
        expect(option.modelId).toBe("");
        expect(matchingGeneralPrompts(localized, item.title)).toContain(item);
        expect(generalPromptOptions("", [item.tags[0]], item.category).some(value => value.id === option.id)).toBe(true);
        const url = new URL(generalPromptDestination(item), "http://localhost");
        expect(url.searchParams.get("prompt")).toBe(item.prompt);
        expect(url.searchParams.has("autoRun")).toBe(false);
        const snapshot = generalPromptSnapshot(item);
        expect(snapshot.prompt).toBe(item.prompt);
        expect(snapshot.title).toBe(item.title);
        expect(snapshot.category).toBe(item.category);
        expect(snapshot.tags).toEqual(item.tags);
        expect(snapshot.notes).not.toMatch(/\p{Script=Han}/u);
        expect(snapshot.notes).toContain("Sources:");
        for (const source of item.sources) expect(snapshot.notes).toContain(`${source.title}: ${source.url}`);
    }
});

test("switching back preserves exact Chinese snapshots and does not rewrite an already selected prompt", async () => {
    await setUiLocale("zh-CN");
    const item = generalPromptTemplates[0];
    const before = generalPromptSnapshot(item);
    const selectedPrompt = generalPromptOptions("", [], "全部")[0].prompt;
    expect(before.notes).toBe(`${item.notes}\n\n参考来源：\n${item.sources.map(source => `${source.title}：${source.url}`).join("\n")}`);
    await setUiLocale("en-US");
    expect(getUiLocale()).toBe("en-US");
    expect(generalPromptOptions("", [], "全部")[0].prompt).not.toBe(selectedPrompt);
    expect(selectedPrompt).toBe(item.prompt);
    await setUiLocale("zh-CN");
    expect(generalPromptSnapshot(getLocalizedGeneralPrompts()[0])).toEqual(before);
    expect(generalPromptOptions("", [], "全部")[0].prompt).toBe(item.prompt);
});

test("prompt catalog and picker static UI strings have English catalog entries", () => {
    const files = ["pages/prompts/index.tsx", "pages/prompts/general-prompt-catalog.tsx", "components/prompts/prompt-select-dialog.tsx", "components/prompts/prompt-card.tsx", "components/prompts/prompt-template-card.tsx", "components/prompts/prompt-template-editor.tsx", "components/prompts/prompt-library-tabs.tsx"];
    for (const file of files) {
        const source = ts.createSourceFile(file, readFileSync(new URL(`../src/${file}`, import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
        const visit = (node: ts.Node) => {
            if (ts.isStringLiteralLike(node) && /\p{Script=Han}/u.test(node.text)) {
                expect(english[node.text as keyof typeof english], `${file}: ${node.text}`).toBeTruthy();
            }
            ts.forEachChild(node, visit);
        };
        visit(source);
    }
    for (const label of Object.values(promptLibrarySourceLabels)) expect(english[label as keyof typeof english], label).toBeTruthy();
});

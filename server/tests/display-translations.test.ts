import { describe, expect, test } from "bun:test";
import { claimDisplayTranslation, displayTranslationHash, displayTranslationInput, displayTranslationRequestSchema, finishDisplayTranslation, protectDisplayLiterals, readDisplayTranslation, reserveDisplayTranslationBudget } from "../src/display-translations";

function cacheFixture() {
    const values = new Map<string, string>();
    return { values, get: async (key: string) => values.get(key) ?? null, eval: async (script: string, options: { keys: string[]; arguments: string[] }) => {
        const key = options.keys[0], args = options.arguments;
        if (script.includes("display-translation-claim-v1")) {
            if (values.has(key)) return [0, values.get(key)];
            values.set(key, args[0]); return [1, args[0]];
        }
        if (script.includes("display-translation-finish-v1")) {
            const raw = values.get(key); if (!raw) return 0;
            const current = JSON.parse(raw);
            if (current.token !== args[0] || current.status !== "pending") return 0;
            values.set(key, args[1]); return 1;
        }
        const count = Number(values.get(key) ?? 0) + Number(args[0]); values.set(key, String(count)); return count;
    } };
}
const request = { target: "en-US" as const, texts: ["原始服装要求"] };
describe("display translation input and literal protection", () => {
    test.each([
        "Read [the original][review].\n\n[review]: //unexpected.example/review",
        "Read [the original][review].\n\n[review]: /unexpected",
        "![image][review]\n\n[review]: /unexpected.png",
        "[unused]: /unexpected",
        "Contact <new@example.com>",
        "Contact new@example.com",
        "Instructions\n\n```sh\nrun-unrequested-command\n```",
        "Instructions with ``new `code` here``",
        "<a href='/unexpected'>Original</a>",
        "Original [link](../unexpected)",
        "Original ![image](//unexpected.example/image.png)",
        "Original <https://unexpected.example>",
        "Original www.unexpected.example",
        "Original\n\n    new indented code",
        "Original\n\n~~~sh\nnew code\n~~~",
        "Original <!-- new HTML -->",
        "Original[^note]\n\n[^note]: New footnote",
    ])("rejects new Markdown resources or executable-looking structure: %s", output => {
        expect(() => protectDisplayLiterals("请阅读原稿").restore(output)).toThrow();
    });
    test("accepts only bounded English display text batches", () => {
        expect(displayTranslationRequestSchema.safeParse(request).success).toBe(true);
        for (const bad of [{ ...request, target: "zh-CN" }, { ...request, modelId: "other" }, { ...request, texts: [] }, { ...request, texts: Array(25).fill("字") }, { ...request, texts: ["字".repeat(12001)] }, { ...request, texts: ["字".repeat(8000), "字".repeat(8000)] }]) expect(displayTranslationRequestSchema.safeParse(bad).success).toBe(false);
    });
    test("keeps original source, code, links, email, placeholders and numbers exact", () => {
        const source = "红色 20cm {count} [原图](/api/assets/a/content) test@example.com\n```js\nconst 名字 = '不能修改';\n```";
        const protectedText = protectDisplayLiterals(source);
        const output = protectedText.restore(protectedText.text.replace("红色", "Red").replace("原图", "Original"));
        expect(output).toBe(source.replace("红色", "Red").replace("原图", "Original"));
        expect(source).toContain("红色");
    });
    test.each([
        "[原图](../assets/原图.png)",
        "[原图](//example.com/原图.png)",
        "[原图](<../assets/原图(a).png> '原始标题')",
        "[原图](../assets/原图\\(a\\).png)",
        "[原图](mailto:original@example.com)",
        "![原图](../assets/原图.png \"原始标题\")",
        "[原图][原键]\n\n[原键]: ../assets/原图.png \"原始标题\"",
        "![原图][原键]\n\n[原键]: //example.com/原图.png",
        "[**原图**](../assets/original.png)",
        "[原图 ![缩略图](/thumb.png)](/original.png)",
    ])("translates visible labels while preserving every original resource: %s", source => {
        const protectedText = protectDisplayLiterals(source);
        const translated = protectedText.text.replace("原图", "Original").replace("缩略图", "Thumbnail");
        const expected = source.replace("原图", "Original").replace("缩略图", "Thumbnail");
        expect(protectedText.restore(translated)).toBe(expected);
    });
    test.each(["[原图]", "[原图][]", "![原图]", "![原图][]"])("keeps shortcut/collapsed reference identity when its visible label changes: %s", reference => {
        const source = `${reference}\n\n[原图]: ../assets/original.png \"原始标题\"`;
        const protectedText = protectDisplayLiterals(source);
        expect(protectedText.restore(protectedText.text.replace("原图", "Original")))
            .toBe(`${reference.startsWith("!") ? "!" : ""}[Original][原图]\n\n[原图]: ../assets/original.png \"原始标题\"`);
    });
    test.each([
        "<original@example.com>", "original@example.com", "https://example.com/原图", "www.example.com",
        "``原始 `代码` 内容``", "```原始 ``代码`` 内容```", "`原始\n代码`",
        "````js\nconst 原始 = `代码`;\n```\n````", "~~~js\nconst 原始 = '代码';\n~~~", "    原始代码\n    不变",
        "<span data-original='原始'>", "<!-- 原始 -->", "[unused]: //example.com/原图 \"原始标题\"",
        "原注[^原键]\n\n[^原键]: 保留原始脚注定义",
    ])("preserves original autolinks, code, definitions and HTML bytes: %s", literal => {
        const source = `红色\n\n${literal}`;
        const protectedText = protectDisplayLiterals(source);
        expect(protectedText.restore(protectedText.text.replace("红色", "Red").replace("原注", "Note")))
            .toBe(source.replace("红色", "Red").replace("原注", "Note"));
    });
    test("rejects rewriting original relative/automatic links even when their old literals remain elsewhere", () => {
        for (const source of ["[原图](/original)", "[原图][原键]\n\n[原键]: //example.com/original", "原图 <original@example.com>"]) {
            const protectedText = protectDisplayLiterals(source);
            const original = protectedText.text.replace("原图", "Original");
            expect(() => protectedText.restore(`${original}\n\n[Replacement](/changed)`)).toThrow();
            expect(() => protectedText.restore(`${original}\n\n[Replacement][new]\n\n[new]: //changed.example`)).toThrow();
        }
    });
    test("rejects changing resource kind, nesting, order or syntax using intact tokens", () => {
        const inline = protectDisplayLiterals("[原图](/original)");
        const translated = inline.text.replace("原图", "Original");
        expect(() => inline.restore(`!${translated}`)).toThrow();
        expect(() => inline.restore(`\`${translated}\``)).toThrow();
        expect(() => inline.restore(`\\${translated}`)).toThrow();
        const images = protectDisplayLiterals("[原图](/original) ![缩略图](/thumb)");
        const tokens = images.text.match(/__VCD_[a-f0-9]+_\d+__/g)!;
        expect(tokens).toHaveLength(4);
        expect(() => images.restore(`${tokens[0]}Original ${tokens[2]}Thumbnail${tokens[3]}${tokens[1]}`)).toThrow();
        expect(() => images.restore(`${tokens[2]}Thumbnail${tokens[3]} ${tokens[0]}Original${tokens[1]}`)).toThrow();
    });
    test("rejects changed literal, untranslated output and injected links/images", () => {
        const source = protectDisplayLiterals("原稿 20");
        expect(() => source.restore("Original 21")).toThrow();
        expect(() => source.restore(source.text)).toThrow();
        expect(() => source.restore(source.text.replace("原稿", "Original") + " https://unexpected.example")).toThrow();
        const token = source.text.match(/__VCD_.*?__/)!;
        expect(() => source.restore(`Original [link](${token[0]})`)).toThrow();
        expect(() => source.restore(`Original ${token[0]} ${token[0].replace("_0__", "_00__")}`)).toThrow();
        expect(() => protectDisplayLiterals("原稿").restore("Original ![image](/new.png)")).toThrow();
    });
    test("accepts only the exact reporting tool and one ordered translation per source", () => {
        const prepared = displayTranslationInput(["红色", "蓝色"]);
        const report = (translations: unknown[], name = "report_display_translations") => ({ content: "", toolCalls: [{ id: "call", type: "function" as const, function: { name, arguments: JSON.stringify({ translations }) } }] });
        expect(prepared.validate(report([{ id: 1, text: "Blue" }, { id: 0, text: "Red" }]))).toEqual(["Red", "Blue"]);
        expect(() => prepared.validate(report([{ id: 0, text: "Red" }]))).toThrow();
        expect(() => prepared.validate(report([{ id: 0, text: "Red" }, { id: 0, text: "Blue" }]))).toThrow();
        expect(() => prepared.validate(report([{ id: 0, text: "Red" }, { id: 1, text: "Blue" }], "execute_task"))).toThrow();
        expect(prepared.input.webSearch).toBe(false);
        expect(prepared.input.tools).toHaveLength(1);
    });
});
describe("private durable translation receipts", () => {
    test("claims once, isolates owners, and never stores source strings", async () => {
        const cache = cacheFixture();
        const first = await claimDisplayTranslation(cache, "owner-a", request);
        const duplicate = await claimDisplayTranslation(cache, "owner-a", request);
        const other = await claimDisplayTranslation(cache, "owner-b", request);
        expect(first.execute).toBe(true); expect(duplicate.execute).toBe(false); expect(other.execute).toBe(true);
        expect([...cache.values.values()].join("")).not.toContain(request.texts[0]);
        expect(displayTranslationHash(request)).not.toBe(displayTranslationHash({ ...request, texts: ["另一个原稿"] }));
        await finishDisplayTranslation(cache, first.receipt, ["Original garment requirements"]);
        expect((await readDisplayTranslation(cache, "owner-a", request))?.translations).toEqual(["Original garment requirements"]);
        expect((await claimDisplayTranslation(cache, "owner-a", request)).execute).toBe(false);
        expect((await readDisplayTranslation(cache, "owner-b", request))?.status).toBe("pending");
        await expect(finishDisplayTranslation(cache, first.receipt)).rejects.toThrow();
    });
    test("a failed or uncertain provider result never becomes an automatic retry", async () => {
        const cache = cacheFixture(), claim = await claimDisplayTranslation(cache, "owner", request);
        await finishDisplayTranslation(cache, claim.receipt);
        const later = await claimDisplayTranslation(cache, "owner", request);
        expect(later.execute).toBe(false); expect(later.receipt.status).toBe("unavailable");
    });
    test("rejects corrupted/other-owner cache and bounds translated characters", async () => {
        const cache = cacheFixture();
        await claimDisplayTranslation(cache, "owner", request);
        const key = [...cache.values.keys()][0];
        const value = JSON.parse(cache.values.get(key)!); value.ownerId = "someone-else"; cache.values.set(key, JSON.stringify(value));
        await expect(readDisplayTranslation(cache, "owner", request)).rejects.toThrow();
        await reserveDisplayTranslationBudget(cache, "owner", 120000);
        await expect(reserveDisplayTranslationBudget(cache, "owner", 1)).rejects.toThrow();
        await expect(reserveDisplayTranslationBudget(cache, "other", 100)).resolves.toBeUndefined();
    });
});

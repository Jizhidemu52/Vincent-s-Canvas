import { describe, expect, test } from "bun:test";
import { createExecutionContract, validatePlannedExecution } from "../src/components/canvas/design-discussion/design-contract.mjs";

describe("design discussion preservation scopes", () => {
    test.each([
        "保留白色翻领，衣身改为深酒红色。",
        "保留原图白色罗纹大翻领，衣身改为深酒红色。",
        "保留纯白色竖罗纹翻领，衣身改为深酒红色。",
    ])("does not turn a colored collar into a whole-garment color lock: %s", request => {
        const contract = createExecutionContract(request);
        expect(contract.preserved.filter(item => item.attribute === "color")).toEqual([
            { attribute: "color", label: "领部颜色", scope: "collar" },
        ]);
        expect(() => validatePlannedExecution(contract, "衣身改为深酒红色。保留纯白色罗纹翻领。")).not.toThrow();
        expect(() => validatePlannedExecution(contract, "衣身改为深酒红色。翻领改为黑色。")).toThrow("领部颜色");
    });

    test("keeps coordinated white collar and sleeve-stripe colors local", () => {
        const contract = createExecutionContract("保留白色翻领和袖侧条纹，衣身改为深酒红色。");
        expect(contract.preserved.filter(item => item.attribute === "color").map(item => item.scope)).toEqual(["collar", "stripes"]);
        expect(() => validatePlannedExecution(contract, "衣身改为深酒红色。保留纯白色罗纹翻领和袖侧白色条纹。")).not.toThrow();
        expect(() => validatePlannedExecution(contract, "衣身改为深酒红色。保留白色翻领。袖侧条纹改为黑色。")).toThrow("条纹颜色");
    });

    test("recognizes a counted stripe object in the actual proposal preservation clause", () => {
        const contract = createExecutionContract("保留白色翻领和袖侧条纹，主体针织纹理与配色可以改变。");
        const plan = "两侧插肩袖改为纯黑色细腻平针针织。双袖外侧保持鲜明的纯白色三条纹。保留纯白色罗纹翻领。";
        expect(() => validatePlannedExecution(contract, plan)).not.toThrow();
        expect(() => validatePlannedExecution(contract, plan + "所有颜色改为红色。")).toThrow("颜色");
    });

    test.each(["保留所有颜色。", "保持整件衣服颜色不变。", "保留原图颜色。"])("retains explicit whole-garment protection: %s", request => {
        const contract = createExecutionContract(request);
        expect(() => validatePlannedExecution(contract, "衣身改为深酒红色。")).toThrow("颜色");
    });

    test("retains noun-before-attribute and English of-object scopes", () => {
        for (const request of ["保持领口颜色不变，衣身改为红色。", "Keep the color of the collar unchanged; change the body color to red."]) {
            const contract = createExecutionContract(request);
            expect(contract.preserved.filter(item => item.attribute === "color").map(item => item.scope)).toEqual(["collar"]);
            expect(() => validatePlannedExecution(contract, "衣身改为红色。保持领口颜色不变。")).not.toThrow();
            expect(() => validatePlannedExecution(contract, "领口颜色改为黑色。")).toThrow("领部颜色");
        }
    });

    test("does not attach an unrelated later object to a global color lock", () => {
        const contract = createExecutionContract("保留白色不变并调整袖口大小。");
        expect(contract.preserved.filter(item => item.attribute === "color").map(item => item.scope)).toEqual(["all"]);
        expect(() => validatePlannedExecution(contract, "衣身改为红色。")).toThrow("颜色");
    });
});

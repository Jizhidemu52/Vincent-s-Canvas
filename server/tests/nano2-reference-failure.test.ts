import { expect, test } from "bun:test";
import { publicGenerationFailure, publicTaskFailurePayload } from "../../shared/generation-error";

test("known local Nano2 input limit stays actionable without exposing arbitrary provider error text", () => {
    const reason = "单张参考图超过 10 MB，请压缩后重试";
    expect(publicGenerationFailure(reason)).toBe("参考图超过当前模型单张 10 MiB 上限，请另存较小副本或切换模型；原图未修改，尚未提交生成。");
    expect(publicGenerationFailure(`${reason}; api_key=private`)).not.toContain("private");
    expect(publicGenerationFailure(reason, "paused")).toContain("不要重复生成");
    const row = { task: { status: "failed", failureReason: reason } };
    const result = publicTaskFailurePayload(row) as typeof row;
    expect(result.task.failureReason).toContain("10 MiB");
    expect(row.task.failureReason).toBe(reason);
});

test.each([
    "管理员尚未配置此场景的优化配方，未提交生成",
    "管理员尚未启用此场景的配方版本，未提交生成",
    "此场景的提示词优化已停用，未提交生成",
    "图片助手配方暂不可用，未提交生成。",
    "图片助手配方过长，未提交生成，请管理员精简配方。",
])("known local recipe failure remains actionable: %s", reason => {
    expect(publicGenerationFailure(reason)).toBe(reason);
    expect(publicGenerationFailure(`${reason}; api_key=private-rule-value`)).not.toContain("private-rule-value");
    expect(publicGenerationFailure(`provider diagnostic: ${reason}`)).not.toBe(`provider diagnostic: ${reason}`);
    expect(publicGenerationFailure(reason, "paused")).toContain("不要重复生成");
    const source = { task: { status: "failed", errorCode: "PROMPT_RECIPE_UNAVAILABLE", failureReason: reason, lastFailure: { phase: "preflight", code: "PROMPT_RECIPE_UNAVAILABLE" } } };
    expect(publicTaskFailurePayload(source)).toEqual(source);
});

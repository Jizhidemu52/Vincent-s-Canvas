import { expect, test } from "bun:test";
import ts from "typescript";
import { AssetObjectError, isMissingAssetObject, missingAssetObjectMessage, readSourceAssetObject, unavailableAssetObjectMessage } from "../src/asset-object-error";
import { publicGenerationFailure } from "../../shared/generation-error";

test("only a definitive missing key can initiate repair; access/network failure stays unavailable", () => {
  expect(isMissingAssetObject({ name: "NoSuchKey" })).toBe(true);
  expect(isMissingAssetObject({ $metadata: { httpStatusCode: 404 } })).toBe(true);
  expect(isMissingAssetObject({ name: "NotFound", $metadata: { httpStatusCode: 403 } })).toBe(false);
  expect(isMissingAssetObject({ name: "TimeoutError" })).toBe(false);
  expect(isMissingAssetObject(null)).toBe(false);
  for (const message of [missingAssetObjectMessage, unavailableAssetObjectMessage]) {
    expect(publicGenerationFailure(message)).toBe(message);
    expect(publicGenerationFailure(`${message} private-key`)).not.toContain("private-key");
    expect(publicGenerationFailure(message, "paused")).toContain("不要重复生成");
  }
});

const worker = ts.createSourceFile("worker.ts", await Bun.file(new URL("../src/worker.ts", import.meta.url)).text(), ts.ScriptTarget.Latest, true);
const names = ["executeApiMartImage", "loadSourceAssets", "loadSourceAsset"];
const code = names.map(name => worker.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name)!.getText(worker)).join("\n");

test("production Worker rejects missing reference bytes before a provider call or submission claim", async () => {
  for (const [storageError, expectedCode] of [
    [{ name: "NoSuchKey", $metadata: { httpStatusCode: 404 } }, "ASSET_OBJECT_MISSING"],
    [{ name: "NotFound", $metadata: { httpStatusCode: 403 } }, "ASSET_STORAGE_UNAVAILABLE"],
    [{ name: "TimeoutError" }, "ASSET_STORAGE_UNAVAILABLE"],
  ] as const) {
    let calls = 0, reads = 0;
    const dependencies = {
      db: { query: async (sql: string, values: unknown[]) => {
        expect(sql).toStartWith("SELECT object_key,mime_type,filename,metadata FROM assets");
        expect(sql).toContain("owner_user_id=$2"); expect(sql).toContain("status='ready'");
        expect(values[1]).toBe("owner");
        return { rows: [{ object_key: "private/original", mime_type: "image/png", filename: "original.png", metadata: {} }] };
      } },
      storage: { get: async (_key: string, options: { abortSignal?: AbortSignal }) => { reads++; expect(options.abortSignal).toBeInstanceOf(AbortSignal); throw storageError; } },
      readSourceAssetObject, AssetObjectError,
      prepareImageEditInput: () => { throw new Error("No bytes may reach image preparation"); },
      stepApiMartImageTask: () => { calls++; throw new Error("No paid provider call permitted"); },
    };
    const execute = new Function(...Object.keys(dependencies), `${ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText}; return executeApiMartImage;`)(...Object.values(dependencies));
    const task = { id: "task", user_id: "owner", parameters: {}, source_urls: ["/api/assets/10000000-0000-4000-8000-000000000001/content"], upstream_task_id: null, upstream_submission_started_at: null };
    await expect(execute(task, {}, "prompt")).rejects.toMatchObject({ code: expectedCode });
    expect(reads).toBe(1); expect(calls).toBe(0);
  }
});

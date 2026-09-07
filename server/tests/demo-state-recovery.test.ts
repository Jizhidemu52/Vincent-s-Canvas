import { expect, test } from "bun:test";
import { readDemoRecovery } from "../src/demo-state-recovery";

test("restores unchanged asset identities and terminal task IDs, rejecting running work", () => {
  const asset = { id: "asset", ownerUserId: "owner", mimeType: "image/png", base64: "AQID" };
  const task = { id: "task", ownerUserId: "owner", status: "success", resultUrls: ["/api/assets/asset/content"] };
  const result = readDemoRecovery({ assets: [asset], tasks: [task] });
  expect(result.assets[0]).toMatchObject({ id: "asset", bytes: new Uint8Array([1, 2, 3]) });
  expect(result.tasks).toEqual([task]);
  expect(() => readDemoRecovery({ tasks: [{ ...task, status: "processing" }] })).toThrow("执行中的任务");
  expect(() => readDemoRecovery({ assets: [{ ...asset, base64: "" }] })).toThrow("空素材");
});

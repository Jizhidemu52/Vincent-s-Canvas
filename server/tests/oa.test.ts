import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { verifyOaToken, OA_SESSION_TTL_SECONDS } from "../src/oa";
import { DemoOaStore } from "../src/demo-oa-store";

test("OA uses bearer GET and confirmed userid/name, accepts the PHP success envelope", async () => {
  const fetcher = (async (url: URL, init: RequestInit) => {
    expect(url.protocol).toBe("https:");
    expect(init.method).toBe("GET");
    expect(init.redirect).toBe("error");
    expect(init.headers).toMatchObject({ Authorization: "Bearer test-token" });
    return Response.json({ userid: "EMP-A", name: "甲" });
  });
  expect(await verifyOaToken("test-token", undefined, fetcher)).toEqual({ id: "EMP-A", name: "甲" });
  for (const errcode of [0, "0"]) {
    expect(await verifyOaToken("test-token", undefined, async () => Response.json({ errcode, data: { userid: "EMP-B", name: "乙" } }))).toEqual({ id: "EMP-B", name: "乙" });
  }
});

test("OA rejects absent/expired identities, old id field, invalid tokens and unsafe endpoints without echoing secrets", async () => {
  for (const body of [{ name: "甲", userid: "" }, { name: "甲", id: "old-id" }, { errcode: 400, data: { userid: "A", name: "甲" } }, { userid: "A" }, null]) {
    await expect(verifyOaToken("test-secret", undefined, async () => Response.json(body))).rejects.toBeInstanceOf(Error);
  }
  for (const token of ["", null, "line\nbreak", "x".repeat(8193)]) await expect(verifyOaToken(token)).rejects.toMatchObject({ code: "OA_TOKEN_INVALID" });
  await expect(verifyOaToken("test-secret", "http://localhost/")).rejects.toMatchObject({ code: "OA_CONFIGURATION_INVALID" });
  await expect(verifyOaToken("test-secret", undefined, async () => { throw new Error("test-secret"); })).rejects.toMatchObject({ code: "OA_UNAVAILABLE", message: "暂时无法连接 OA 登录服务，请稍后从企业微信重新打开。" });
});

test("employee identities and hashed sessions persist; token rotation, expiry, revocation never merge people", () => {
  const directory = mkdtempSync(join(tmpdir(), "canvas-oa-test-"));
  const path = join(directory, "state.sqlite");
  let store = new DemoOaStore(path);
  try {
    const a = store.login({ id: "employee-a", name: "同名" }, 1000);
    const b = store.login({ id: "employee-b", name: "同名" }, 1000);
    expect(a.user.id).not.toBe(b.user.id);
    expect(a.user.role).toBe("designer");
    const rotated = store.login({ id: "employee-a", name: "改名" }, 2000);
    expect(rotated.user.id).toBe(a.user.id);
    expect(rotated.token).not.toBe(a.token);
    store.close(); store = new DemoOaStore(path);
    expect(store.session(a.token, 3000)?.displayName).toBe("改名");
    expect(store.session(b.token, 3000)?.id).toBe(b.user.id);
    expect(store.session(a.token, 1000 + OA_SESSION_TTL_SECONDS * 1000)).toBeNull();
    store.revoke(rotated.token);
    expect(store.session(rotated.token, 3000)).toBeNull();
    expect(store.session("old-admin-token", 3000)).toBeNull();
    const db = new Database(path, { readonly: true });
    try { expect(JSON.stringify(db.query("SELECT * FROM demo_oa_sessions").all())).not.toContain(b.token); } finally { db.close(); }
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

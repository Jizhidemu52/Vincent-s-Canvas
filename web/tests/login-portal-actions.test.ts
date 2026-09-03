import { expect, test } from "bun:test";

import { loginPortalActions } from "@/lib/login-portal-actions";

test("exposes only enterprise WeCom and administrator entry actions", () => {
    expect(loginPortalActions).toEqual([
        { id: "wecom", label: "企业微信扫码登录" },
        { id: "admin", label: "管理员登录" },
    ]);
});

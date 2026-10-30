import { expect, test } from "bun:test";
import { safeLoginReturn } from "../src/lib/login-return";
test("login return stays inside the app and retains navigation context", () => {
    expect(safeLoginReturn("/admin?tab=projects")).toBe("/admin?tab=projects");
    expect(safeLoginReturn("/canvas/abc?token=secret&oa_token=secret&tool=image#node")).toBe("/canvas/abc?tool=image#node");
    for (const value of ["https://evil.test", "//evil.test", "/\\evil.test", "/login", "/admin/login?x=1", "javascript:alert(1)", null, "\r/evil"]) expect(safeLoginReturn(value, "/admin")).toBe("/admin");
});

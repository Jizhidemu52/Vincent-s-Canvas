import { expect, test } from "bun:test";

import { shouldBypassStandaloneAuthGate, shouldBypassStandaloneModuleGate } from "@/lib/standalone-access";

test("lets the desktop no-login edition enter ordinary workspaces without an auth session", () => {
    expect(shouldBypassStandaloneAuthGate(true, false)).toBe(true);
    expect(shouldBypassStandaloneAuthGate(false, false)).toBe(false);
});

test("keeps administrator routes protected while the no-login edition bypasses module fetching", () => {
    expect(shouldBypassStandaloneAuthGate(true, true)).toBe(false);
    expect(shouldBypassStandaloneModuleGate(true)).toBe(true);
    expect(shouldBypassStandaloneModuleGate(false)).toBe(false);
});

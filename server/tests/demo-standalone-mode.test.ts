import { expect, test } from "bun:test";

import { billedDemoCredits, resolveStandaloneDemoUser } from "../src/demo-standalone-mode";

test("assigns the fixed local designer identity only in standalone mode", () => {
  expect(resolveStandaloneDemoUser(false)).toBeNull();
  expect(resolveStandaloneDemoUser(true)).toMatchObject({
    username: "designer01",
    role: "designer",
    mustChangePassword: false,
  });
});

test("sets every standalone task charge to zero without changing regular demo charges", () => {
  expect(billedDemoCredits(true, 12)).toBe(0);
  expect(billedDemoCredits(false, 12)).toBe(12);
});

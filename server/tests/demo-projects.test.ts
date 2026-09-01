import { expect, test } from "bun:test";

import { syncDemoProject } from "../src/demo-projects";

test("accepts a canvas project sync and returns the project identity", () => {
  expect(
    syncDemoProject({ externalId: "canvas-123", name: "服装设计画布" }),
  ).toMatchObject({
    project: { externalId: "canvas-123", name: "服装设计画布" },
  });
});

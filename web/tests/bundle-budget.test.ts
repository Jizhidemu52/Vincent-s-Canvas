import { expect, test } from "bun:test";

import { bundleBudgetViolations, CANVAS_PROJECT_BUDGET, isCanvasProjectBundle } from "../scripts/bundle-budget.mjs";

test("selects the hashed canvas route without counting workbench project-session chunks", () => {
    expect(isCanvasProjectBundle("project-tA8VYIap.js")).toBe(true);
    expect(isCanvasProjectBundle("project-a_-A1234.js")).toBe(true);
    expect(isCanvasProjectBundle("project-session-DnTFljQ6.js")).toBe(false);
    expect(isCanvasProjectBundle("project-DCWsHngD.css")).toBe(false);
});

test("keeps the canvas project entry within its initial-load budget", () => {
    expect(bundleBudgetViolations([{ name: "project-demo.js", bytes: CANVAS_PROJECT_BUDGET.rawBytes, gzipBytes: CANVAS_PROJECT_BUDGET.gzipBytes }])).toEqual([]);
});

test("reports an oversized canvas project entry before it can ship", () => {
    expect(bundleBudgetViolations([{ name: "project-demo.js", bytes: CANVAS_PROJECT_BUDGET.rawBytes + 1, gzipBytes: CANVAS_PROJECT_BUDGET.gzipBytes }])).toEqual([`project-demo.js exceeds raw budget: ${CANVAS_PROJECT_BUDGET.rawBytes + 1} B > ${CANVAS_PROJECT_BUDGET.rawBytes} B`]);
});

test("reports an oversized gzip entry before it can ship", () => {
    expect(bundleBudgetViolations([{ name: "project-demo.js", bytes: CANVAS_PROJECT_BUDGET.rawBytes, gzipBytes: CANVAS_PROJECT_BUDGET.gzipBytes + 1 }])).toEqual([`project-demo.js exceeds gzip budget: ${CANVAS_PROJECT_BUDGET.gzipBytes + 1} B > ${CANVAS_PROJECT_BUDGET.gzipBytes} B`]);
});

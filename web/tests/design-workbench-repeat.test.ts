import { test } from "bun:test";
import assert from "node:assert/strict";
import { cmToPx, periodSize, wrapPosition, latticeCopies, mirrorCellTransform, validateExport, hitElement, previewSize } from "../src/pages/design-workbench/local/repeat/geometry.mjs";

test("repeat geometry: wrapping, half-drop lattice, mirror period, dimensions and limits", () => {
    assert.equal(cmToPx(2.54, 300), 300);
    assert.equal(cmToPx(10, 150), 591);
    assert.throws(() => cmToPx(0, 300));
    assert.deepEqual(periodSize(100, 80, "straight"), { width: 100, height: 80 });
    assert.deepEqual(periodSize(100, 80, "half"), { width: 200, height: 80 });
    assert.deepEqual(periodSize(100, 80, "mirror"), { width: 200, height: 160 });
    const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-8, `${a} != ${b}`);
    let wrapped = wrapPosition(1.1, 0.2, "straight");
    near(wrapped.x, 0.1);
    near(wrapped.y, 0.2);
    wrapped = wrapPosition(1.1, 0.2, "half");
    near(wrapped.x, 0.1);
    near(wrapped.y, 0.7);
    wrapped = wrapPosition(-0.1, 0.2, "half");
    near(wrapped.x, 0.9);
    near(wrapped.y, 0.7);
    wrapped = wrapPosition(2.1, 1.2, "half");
    near(wrapped.x, 0.1);
    near(wrapped.y, 0.2);
    const item = { x: 0.96, y: 0.3, size: 0.25, ratio: 1, angle: 0 };
    const straight = latticeCopies(item, 100, 100);
    assert.ok(
        straight.some((c) => c.x === -4 && c.y === 30),
        "right-edge artwork must appear on the left",
    );
    const half = latticeCopies(item, 100, 100, 100, 100, "half");
    assert.ok(
        half.some((c) => c.x === -4 && c.y === 80),
        "half-drop edge crossing must shift half a row",
    );
    const field = latticeCopies(item, 100, 80, 600, 320, "half");
    const centers = new Set(field.map((c) => `${c.x.toFixed(3)},${c.y.toFixed(3)}`));
    for (const c of field.filter((c) => c.x >= 0 && c.x <= 350 && c.y >= 0 && c.y <= 160)) {
        assert.ok(centers.has(`${(c.x + 200).toFixed(3)},${c.y.toFixed(3)}`), "half-drop rectangle repeats every 2W");
        assert.ok(centers.has(`${c.x.toFixed(3)},${(c.y + 80).toFixed(3)}`), "half-drop rectangle repeats every H");
    }
    const a = mirrorCellTransform(1, 1, 100, 80);
    assert.deepEqual(a, { x: 200, y: 160, scaleX: -1, scaleY: -1 });
    const b = mirrorCellTransform(3, 3, 100, 80);
    assert.equal(b.scaleX, a.scaleX);
    assert.equal(b.scaleY, a.scaleY);
    assert.equal(b.x - a.x, 200);
    assert.equal(b.y - a.y, 160);
    assert.equal(validateExport(2048, 2048, "mirror").valid, false, "16MP cap also applies");
    assert.equal(validateExport(2048, 1000, "half").valid, true);
    assert.equal(validateExport(2049, 100, "half").valid, false);
    assert.equal(hitElement({ x: 0, y: 15 }, { x: 0, y: 0, width: 40, height: 10 }, 90), true);
    assert.equal(previewSize(1000, 500).width, 1600);
    assert.throws(() => latticeCopies({ x: 0.5, y: 0.5, size: 1.2, ratio: 1 / 8192, angle: 45 }, 100, 100), /密度过大/);
});

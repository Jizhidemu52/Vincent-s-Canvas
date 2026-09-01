# 无限画布高性能渲染 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在保留现有 DOM 可编辑节点与画布数据格式的前提下，使 500 节点、1,000 连线画布的平移、缩放和拖拽只更新必要内容。

**Architecture:** 文档节点/连线保持在现有 `WirelessCanvasPage` 状态中；实时手势数据使用 rAF 驱动的预览状态，交互结束时一次提交文档状态。固定网格空间索引用于视口查询，DOM 层只渲染可见节点；Canvas 图层批量绘制可见连线，透明 SVG 命中层维持现有选择和右键行为。

**Tech Stack:** React 19、TypeScript、Zustand、Tailwind、Bun Test、Vite、HTML Canvas 2D。

**Spec:** `docs/superpowers/specs/2026-09-01-canvas-performance-architecture.md`

## Global Constraints

- 不改变 `CanvasProject` 的持久化 JSON 结构，也不做旧画布迁移。
- 不修改生图、生视频、LLM、认证、额度或供应商 API。
- 节点仍由 DOM 渲染，以保留双击编辑、上传、媒体播放、Agent 和导出能力。
- 交互期间视觉降级只影响显示；节点数据、选择、导出和生成输入必须完全一致。
- Canvas 连线失败时必须自动使用现有 SVG 连线；生产环境默认不显示性能仪表。
- 所有新增行为先写 Bun 单元测试并确认 RED，再写最小实现；每任务独立提交。

---

## File Structure

- `web/src/lib/canvas/canvas-spatial-index.ts` — 节点边界、固定网格索引和视口查询。
- `web/src/lib/canvas/canvas-drag-preview.ts` — 拖拽位置预览的纯函数，避免每帧修改完整节点数组。
- `web/src/lib/canvas/canvas-render-quality.ts` — `moving`/`full` 渲染质量状态和延迟恢复规则。
- `web/src/lib/canvas/canvas-connection-geometry.ts` — 贝塞尔路径、路径边界和节点邻接索引。
- `web/src/lib/canvas/canvas-performance-metrics.ts` — 交互 FPS/P95/长帧采样，不读取用户内容。
- `web/src/components/canvas/canvas-connection-layer.tsx` — Canvas 2D 连线绘制与 SVG 回退。
- `web/src/components/canvas/canvas-node.tsx` — 接受临时位置和渲染质量，不改变节点数据模型。
- `web/src/components/canvas/wireless-canvas.tsx` — 上报平移/缩放交互状态。
- `web/src/pages/canvas/project.tsx` — 组合索引、可见节点、拖拽预览、连线层和开发性能面板。
- `web/tests/canvas-*.test.ts` — 对应纯逻辑的回归测试。

## Interfaces

```ts
export type CanvasBounds = { minX: number; minY: number; maxX: number; maxY: number };

export type CanvasSpatialIndex = {
  cellSize: number;
  boundsByNodeId: Map<string, CanvasBounds>;
  cells: Map<string, Set<string>>;
};

export function createCanvasSpatialIndex(nodes: CanvasNodeData[], cellSize?: number): CanvasSpatialIndex;
export function queryCanvasSpatialIndex(index: CanvasSpatialIndex, bounds: CanvasBounds): string[];
export function boundsForCanvasNode(node: CanvasNodeData): CanvasBounds;
export function boundsForViewport(viewport: ViewportTransform, width: number, height: number, padding: number): CanvasBounds;

export type CanvasRenderQuality = "full" | "moving";
export type CanvasDragPreview = ReadonlyMap<string, Position>;
export function createDragPreview(initial: ReadonlyArray<{ id: string; x: number; y: number }>, dx: number, dy: number): Map<string, Position>;
export function resolvePreviewPosition(node: CanvasNodeData, preview: CanvasDragPreview): Position;

export type CanvasConnectionGeometry = { d: string; bounds: CanvasBounds };
export function createConnectionGeometry(from: CanvasNodeData, to: CanvasNodeData): CanvasConnectionGeometry;
export function createConnectionAdjacency(connections: CanvasConnection[]): Map<string, Set<string>>;
```

### Task 1: 固定网格空间索引

**Files:**
- Create: `web/src/lib/canvas/canvas-spatial-index.ts`
- Create: `web/tests/canvas-spatial-index.test.ts`

**Interfaces:**
- Consumes: `CanvasNodeData`、`ViewportTransform` from `web/src/types/canvas.ts`.
- Produces: `CanvasBounds`, `CanvasSpatialIndex`, `createCanvasSpatialIndex`, `queryCanvasSpatialIndex`, `boundsForCanvasNode`, `boundsForViewport`.

- [ ] **Step 1: 写失败测试，定义节点跨格、负坐标和视口查询语义**

```ts
import { describe, expect, test } from "bun:test";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";
import { boundsForViewport, createCanvasSpatialIndex, queryCanvasSpatialIndex } from "@/lib/canvas/canvas-spatial-index";

const node = (id: string, x: number, y: number, width = 100, height = 100): CanvasNodeData => ({ id, type: CanvasNodeType.Text, title: id, position: { x, y }, width, height });

describe("canvas spatial index", () => {
  test("returns each node once when it spans multiple grid cells", () => {
    const index = createCanvasSpatialIndex([node("wide", 900, 0, 300, 100), node("negative", -80, -80)], 1024);
    expect(queryCanvasSpatialIndex(index, { minX: 800, minY: -100, maxX: 1300, maxY: 200 })).toEqual(["wide"]);
  });

  test("converts a translated viewport and padding into world bounds", () => {
    expect(boundsForViewport({ x: 200, y: 100, k: 2 }, 400, 200, 50)).toEqual({ minX: -150, minY: -100, maxX: 150, maxY: 100 });
  });
});
```

- [ ] **Step 2: 运行测试，确认因为模块不存在而失败**

Run: `bun test ./tests/canvas-spatial-index.test.ts` from `web`.

Expected: FAIL with `Cannot find module '@/lib/canvas/canvas-spatial-index'`.

- [ ] **Step 3: 实现最小固定网格索引**

```ts
export function boundsForCanvasNode(node: CanvasNodeData): CanvasBounds {
  return { minX: node.position.x, minY: node.position.y, maxX: node.position.x + node.width, maxY: node.position.y + node.height };
}

export function queryCanvasSpatialIndex(index: CanvasSpatialIndex, bounds: CanvasBounds): string[] {
  const ids = new Set<string>();
  forEachCell(bounds, index.cellSize, (key) => index.cells.get(key)?.forEach((id) => ids.add(id)));
  return [...ids].filter((id) => intersects(index.boundsByNodeId.get(id), bounds));
}
```

Implement `forEachCell` with `Math.floor(coordinate / cellSize)` for both negative and positive coordinates. Build `cells` and `boundsByNodeId` once in `createCanvasSpatialIndex`; do not mutate input nodes.

- [ ] **Step 4: 运行空间索引测试，确认通过**

Run: `bun test ./tests/canvas-spatial-index.test.ts` from `web`.

Expected: 2 pass, 0 fail.

- [ ] **Step 5: 提交索引实现与测试**

```bash
git add web/src/lib/canvas/canvas-spatial-index.ts web/tests/canvas-spatial-index.test.ts
git commit -m "feat: add canvas spatial index"
```

### Task 2: 拖拽预览与一次性文档提交

**Files:**
- Create: `web/src/lib/canvas/canvas-drag-preview.ts`
- Create: `web/tests/canvas-drag-preview.test.ts`
- Modify: `web/src/components/canvas/canvas-node.tsx`
- Modify: `web/src/pages/canvas/project.tsx`

**Interfaces:**
- Consumes: `CanvasNodeData`, `Position` from `web/src/types/canvas.ts`.
- Produces: `CanvasDragPreview`, `createDragPreview`, `resolvePreviewPosition`; `CanvasNode` accepts `previewPosition?: Position` and `renderQuality: CanvasRenderQuality`.

- [ ] **Step 1: 写失败测试，规定预览不得修改原始节点位置**

```ts
import { describe, expect, test } from "bun:test";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";
import { createDragPreview, resolvePreviewPosition } from "@/lib/canvas/canvas-drag-preview";

const source: CanvasNodeData = { id: "a", type: CanvasNodeType.Text, title: "a", position: { x: 10, y: 20 }, width: 100, height: 50 };

describe("canvas drag preview", () => {
  test("keeps document positions unchanged while exposing an rAF preview", () => {
    const preview = createDragPreview([{ id: "a", x: 10, y: 20 }, { id: "b", x: -5, y: 3 }], 12, -8);
    expect(resolvePreviewPosition(source, preview)).toEqual({ x: 22, y: 12 });
    expect(source.position).toEqual({ x: 10, y: 20 });
    expect(preview.get("b")).toEqual({ x: 7, y: -5 });
  });
});
```

- [ ] **Step 2: 运行测试，确认 RED**

Run: `bun test ./tests/canvas-drag-preview.test.ts` from `web`.

Expected: FAIL with missing `canvas-drag-preview` module.

- [ ] **Step 3: 实现预览工具并将它接入节点位置**

```ts
export function createDragPreview(initial: ReadonlyArray<{ id: string; x: number; y: number }>, dx: number, dy: number) {
  return new Map(initial.map(({ id, x, y }) => [id, { x: x + dx, y: y + dy }]));
}

export function resolvePreviewPosition(node: CanvasNodeData, preview: CanvasDragPreview): Position {
  return preview.get(node.id) ?? node.position;
}
```

In `CanvasNode`, resolve `previewPosition ?? data.position` only for inline `left`/`top` positioning and add it to the memo comparator. In `WirelessCanvasPage`, replace the per-rAF `setNodes(prev.map(...))` inside `handleGlobalMouseMove` with `setDragPreviewById(createDragPreview(...))`. In `finishNodeDrag`, build the final `nodes` array once from the current preview map, call `setNodes` once, then clear the preview map. Keep history paused until this one committed update.

- [ ] **Step 4: 运行预览测试和现有节点稳定性测试**

Run: `bun test ./tests/canvas-drag-preview.test.ts ./tests/canvas-render-stability.test.ts` from `web`.

Expected: all pass.

- [ ] **Step 5: 浏览器验证单节点和多选拖拽**

Run: `npx --yes --package @playwright/cli playwright-cli open http://127.0.0.1:5188/canvas`.

Create a text node, multi-select it with a second node, drag both, release, reload, and verify final positions persist. Inspect browser console; expected 0 errors.

- [ ] **Step 6: 提交拖拽预览实现**

```bash
git add web/src/lib/canvas/canvas-drag-preview.ts web/tests/canvas-drag-preview.test.ts web/src/components/canvas/canvas-node.tsx web/src/pages/canvas/project.tsx
git commit -m "perf: preview canvas node drags outside document state"
```

### Task 3: 交互质量 LOD

**Files:**
- Create: `web/src/lib/canvas/canvas-render-quality.ts`
- Create: `web/tests/canvas-render-quality.test.ts`
- Modify: `web/src/components/canvas/wireless-canvas.tsx`
- Modify: `web/src/components/canvas/canvas-node.tsx`
- Modify: `web/src/pages/canvas/project.tsx`

**Interfaces:**
- Consumes: `CanvasRenderQuality` and the existing node/pan interaction lifecycle.
- Produces: `CanvasRenderQuality`, `nextCanvasRenderQuality`, `WirelessCanvasProps.onInteractionChange?: (active: boolean) => void`.

- [ ] **Step 1: 写失败测试，规定连续交互不能提前恢复全质量**

```ts
import { describe, expect, test } from "bun:test";
import { nextCanvasRenderQuality } from "@/lib/canvas/canvas-render-quality";

describe("canvas render quality", () => {
  test("stays in moving quality until the final interaction settles", () => {
    expect(nextCanvasRenderQuality("full", true)).toBe("moving");
    expect(nextCanvasRenderQuality("moving", true)).toBe("moving");
    expect(nextCanvasRenderQuality("moving", false)).toBe("full");
  });
});
```

- [ ] **Step 2: 运行测试，确认 RED**

Run: `bun test ./tests/canvas-render-quality.test.ts` from `web`.

Expected: FAIL with missing module.

- [ ] **Step 3: 实现质量状态与 150ms 恢复**

```ts
export type CanvasRenderQuality = "full" | "moving";
export const nextCanvasRenderQuality = (_current: CanvasRenderQuality, active: boolean): CanvasRenderQuality => (active ? "moving" : "full");
```

In `WirelessCanvas`, call `onInteractionChange(true)` before the first pan or wheel preview. On pointer-up, call `onInteractionChange(false)` after committing; on wheel, call it false only from the existing 120ms settle timer. In `WirelessCanvasPage`, combine pan/zoom activity with `isNodeDragging`; schedule the transition back to `full` after 150ms and cancel that timer if another interaction begins. Pass the resulting quality to nodes and connection layer.

For `moving`, remove root node `boxShadow`, disable transition/hover scale classes, suppress `backdrop-blur` utility classes on node overlays, and pass `active={false}` visual style to nonessential connection highlights. Do not change selected node border or hit targets.

- [ ] **Step 4: 运行 LOD 和视口测试**

Run: `bun test ./tests/canvas-render-quality.test.ts ./tests/canvas-viewport-interaction.test.ts` from `web`.

Expected: all pass.

- [ ] **Step 5: 浏览器验证缩放期间与停止后的视觉切换**

Use Playwright to zoom from 100% to at least 140%, wait 250ms, and inspect that the node is still selectable and the browser console has 0 errors. Verify the node regains its normal shadow after the wait.

- [ ] **Step 6: 提交 LOD 实现**

```bash
git add web/src/lib/canvas/canvas-render-quality.ts web/tests/canvas-render-quality.test.ts web/src/components/canvas/wireless-canvas.tsx web/src/components/canvas/canvas-node.tsx web/src/pages/canvas/project.tsx
git commit -m "perf: add canvas interaction render quality"
```

### Task 4: 将视口裁剪切换到空间索引

**Files:**
- Modify: `web/src/lib/canvas/canvas-spatial-index.ts`
- Modify: `web/src/pages/canvas/project.tsx`
- Modify: `web/tests/canvas-spatial-index.test.ts`

**Interfaces:**
- Consumes: `createCanvasSpatialIndex`, `queryCanvasSpatialIndex`, `boundsForViewport` from Task 1.
- Produces: `selectIndexedCanvasNodes(nodes, index, bounds, exclude)` and `visibleNodes` derived from it with existing batch-collapse rules preserved.

- [ ] **Step 1: 写失败测试，规定索引结果仍受隐藏批处理子节点规则约束**

```ts
import { selectIndexedCanvasNodes } from "@/lib/canvas/canvas-spatial-index";

test("returns only intersecting non-hidden node ids after the project batch filter", () => {
  const index = createCanvasSpatialIndex([node("root", 0, 0), node("child", 20, 20), node("far", 5000, 5000)]);
  const visible = selectIndexedCanvasNodes([node("root", 0, 0), node("child", 20, 20), node("far", 5000, 5000)], index, { minX: -50, minY: -50, maxX: 400, maxY: 400 }, (item) => item.id === "child");
  expect(visible.map((item) => item.id)).toEqual(["root"]);
});
```

- [ ] **Step 2: 运行测试，确认当前期望失败或缺少批处理场景**

Run: `bun test ./tests/canvas-spatial-index.test.ts` from `web`.

Expected: FAIL with missing `selectIndexedCanvasNodes` export.

- [ ] **Step 3: 以索引候选替换全量 `nodes.filter`**

Add this pure selector to `canvas-spatial-index.ts`:

```ts
export function selectIndexedCanvasNodes(
  nodes: CanvasNodeData[],
  index: CanvasSpatialIndex,
  bounds: CanvasBounds,
  exclude: (node: CanvasNodeData) => boolean,
) {
  const candidateIds = new Set(queryCanvasSpatialIndex(index, bounds));
  return nodes.filter((node) => candidateIds.has(node.id) && !exclude(node));
}
```

Build `spatialIndex` with `useMemo(() => createCanvasSpatialIndex(nodes), [nodes])`. Compute world bounds with `boundsForViewport(viewport, width, height, 280)`, then use `selectIndexedCanvasNodes(nodes, spatialIndex, bounds, (node) => isHiddenBatchChild(node, nodes, collapsingBatchIds))`. Preserve original node order through the selector.

Do not use the index for text search, export, Agent operations or persistence; those must still receive the complete `nodes` array.

- [ ] **Step 4: 运行索引、批处理和前端全量测试**

Run: `bun test ./tests/canvas-spatial-index.test.ts ./tests/generation-tasks.test.ts && bun test` from `web`.

Expected: all frontend tests pass.

- [ ] **Step 5: 提交空间索引接入**

```bash
git add web/src/pages/canvas/project.tsx web/tests/canvas-spatial-index.test.ts
git commit -m "perf: query visible canvas nodes through spatial index"
```

### Task 5: 连线几何、邻接缓存与 Canvas 渲染层

**Files:**
- Create: `web/src/lib/canvas/canvas-connection-geometry.ts`
- Create: `web/src/components/canvas/canvas-connection-layer.tsx`
- Create: `web/tests/canvas-connection-geometry.test.ts`
- Modify: `web/src/components/canvas/canvas-connections.tsx`
- Modify: `web/src/pages/canvas/project.tsx`

**Interfaces:**
- Consumes: `CanvasConnection`, `CanvasNodeData`, `CanvasBounds`, `CanvasRenderQuality`.
- Produces: `createConnectionGeometry`, `createConnectionAdjacency`, `CanvasConnectionLayer`, and an SVG hit-path renderer that accepts existing `onSelect` and `onContextMenu` callbacks.

- [ ] **Step 1: 写失败测试，规定非相邻连线不会因一个节点移动而失效**

```ts
import { describe, expect, test } from "bun:test";
import { CanvasNodeType, type CanvasConnection, type CanvasNodeData } from "@/types/canvas";
import { createConnectionAdjacency, createConnectionGeometry } from "@/lib/canvas/canvas-connection-geometry";

const a: CanvasNodeData = { id: "a", type: CanvasNodeType.Text, title: "a", position: { x: 0, y: 0 }, width: 100, height: 50 };
const b: CanvasNodeData = { id: "b", type: CanvasNodeType.Text, title: "b", position: { x: 300, y: 0 }, width: 100, height: 50 };

test("indexes only connections adjacent to a moved node", () => {
  const links: CanvasConnection[] = [{ id: "ab", fromNodeId: "a", toNodeId: "b" }, { id: "cd", fromNodeId: "c", toNodeId: "d" }];
  expect(createConnectionAdjacency(links).get("a")).toEqual(new Set(["ab"]));
  expect(createConnectionGeometry(a, b).d).toContain("M 100 25 C");
});
```

- [ ] **Step 2: 运行测试，确认 RED**

Run: `bun test ./tests/canvas-connection-geometry.test.ts` from `web`.

Expected: FAIL with missing geometry module.

- [ ] **Step 3: 实现纯几何与邻接缓存**

```ts
export function createConnectionAdjacency(connections: CanvasConnection[]) {
  const byNodeId = new Map<string, Set<string>>();
  for (const connection of connections) {
    for (const nodeId of [connection.fromNodeId, connection.toNodeId]) {
      const ids = byNodeId.get(nodeId) ?? new Set<string>();
      ids.add(connection.id);
      byNodeId.set(nodeId, ids);
    }
  }
  return byNodeId;
}
```

Implement `createConnectionGeometry` from the existing cubic-bezier formula in `ConnectionPath`; return SVG `d` and endpoint-inclusive bounds. Create `new Path2D(geometry.d)` only inside the browser-only `CanvasConnectionLayer`, then cache that `Path2D` by connection ID plus the `from`/`to` object references. Recompute only when either endpoint reference changes.

- [ ] **Step 4: 建立 Canvas 视觉层与 SVG 命中回退层**

`CanvasConnectionLayer` must size its `<canvas>` with `devicePixelRatio`, clear only the current visible world rect, apply `ctx.setTransform(viewport.k * dpr, 0, 0, viewport.k * dpr, viewport.x * dpr, viewport.y * dpr)`, and draw only connections for which either endpoint is in the visible-node ID set. Draw active lines with 3px stroke and normal lines with 2px stroke; omit shadow while quality is `moving`.

Keep an SVG layer that renders only transparent 16px hit paths for the same visible connection IDs. If `CanvasRenderingContext2D` is unavailable or a draw throws, call `onCanvasError` once and render the existing visual `ConnectionPath` SVG implementation for that session.

- [ ] **Step 5: 运行几何、现有连线稳定性和前端全量测试**

Run: `bun test ./tests/canvas-connection-geometry.test.ts ./tests/canvas-connection-render-stability.test.ts && bun test` from `web`.

Expected: all frontend tests pass.

- [ ] **Step 6: 浏览器验证连线操作与回退**

Create two text nodes, connect them, select the line, open its right-click menu, drag one endpoint, reload, and verify the connection persists. Temporarily force `onCanvasError` in a local test build and repeat selection/right-click on the SVG fallback. Expected: both modes have 0 console errors.

- [ ] **Step 7: 提交连线渲染层**

```bash
git add web/src/lib/canvas/canvas-connection-geometry.ts web/src/components/canvas/canvas-connection-layer.tsx web/src/components/canvas/canvas-connections.tsx web/src/pages/canvas/project.tsx web/tests/canvas-connection-geometry.test.ts
git commit -m "perf: render canvas connections through cached layer"
```

### Task 6: 开发性能仪表与可复现压力夹具

**Files:**
- Create: `web/src/lib/canvas/canvas-performance-metrics.ts`
- Create: `web/src/components/canvas/canvas-performance-panel.tsx`
- Create: `web/tests/canvas-performance-metrics.test.ts`
- Modify: `web/src/pages/canvas/project.tsx`

**Interfaces:**
- Consumes: interaction start/end notifications, visible node/connection counts.
- Produces: `CanvasInteractionMetrics`, `createCanvasPerformanceTracker`, `CanvasPerformancePanel` displayed only when `import.meta.env.DEV` and `?perf=1` are both true.

- [ ] **Step 1: 写失败测试，规定 P95 与长帧采样不读取节点内容**

```ts
import { expect, test } from "bun:test";
import { createCanvasPerformanceTracker } from "@/lib/canvas/canvas-performance-metrics";

test("reports frame timing statistics without storing canvas content", () => {
  const tracker = createCanvasPerformanceTracker();
  tracker.start("pan", 0);
  tracker.frame(16);
  tracker.frame(70);
  const metrics = tracker.finish(90, { totalNodes: 500, visibleNodes: 42, totalConnections: 1000, visibleConnections: 85 });
  expect(metrics.p95FrameMs).toBe(70);
  expect(metrics.longFrameCount).toBe(1);
  expect(JSON.stringify(metrics)).not.toContain("prompt");
});
```

- [ ] **Step 2: 运行测试，确认 RED**

Run: `bun test ./tests/canvas-performance-metrics.test.ts` from `web`.

Expected: FAIL with missing metrics module.

- [ ] **Step 3: 实现本地性能采样与仪表**

`CanvasInteractionMetrics` contains only `interaction`, `averageFps`, `p95FrameMs`, `maxFrameMs`, `longFrameCount`, `totalNodes`, `visibleNodes`, `totalConnections`, and `visibleConnections`. `createCanvasPerformanceTracker` stores numeric timestamps in a local array, computes a sorted nearest-rank P95, and clears samples after `finish`.

In `WirelessCanvasPage`, begin sampling when interaction becomes active, schedule `tracker.frame(performance.now())` with rAF while active, and finish after the 150ms quality-settle delay. Render `CanvasPerformancePanel` only for `?perf=1` in development. Do not put metrics into `CanvasProject`, Zustand persistence, analytics, logs, or exports.

- [ ] **Step 4: 运行指标测试、完整前端测试与生产构建**

Run: `bun test ./tests/canvas-performance-metrics.test.ts && bun test && bun run build` from `web`.

Expected: all tests pass and Vite build exits 0.

- [ ] **Step 5: 浏览器压力验收**

Create a development-only local fixture through a browser console/test helper with 500 text nodes and 1,000 connections. With `?perf=1`, perform pan, zoom and a single-node drag. Verify: no console errors, metrics report total 500/1,000, visible counts are lower than totals, and the node retains its committed position after refresh.

- [ ] **Step 6: 提交仪表与夹具**

```bash
git add web/src/lib/canvas/canvas-performance-metrics.ts web/src/components/canvas/canvas-performance-panel.tsx web/src/pages/canvas/project.tsx web/tests/canvas-performance-metrics.test.ts
git commit -m "feat: measure canvas interaction performance"
```

### Task 7: 最终回归、回退和交付验证

**Files:**
- Modify: `web/src/pages/canvas/project.tsx` only if browser verification reveals a concrete defect.
- Test: `web/tests/*.test.ts`, browser local build, server suite.

**Interfaces:**
- Consumes: all previous task interfaces.
- Produces: a verified production build served by the existing local deployment and a short evidence record.

- [ ] **Step 1: 从干净浏览器会话验证正常路径**

Open `http://127.0.0.1:5188/canvas`, create a canvas, add text/image/config/video nodes, connect two nodes, pan, zoom, select, multi-select, drag, edit text, trigger a safe non-billed UI opening, refresh, and export. Verify no test fixture or temporary data remains afterward.

- [ ] **Step 2: 验证边界与错误路径**

Test empty canvas, negative-position node, node spanning an index cell boundary, 1 node/0 connections, 500 nodes/1,000 connections, forced Canvas draw failure, and a background-tab interaction pause. Verify SVG fallback, no duplicate connections, no lost node positions, and no data persistence change.

- [ ] **Step 3: 运行全量验证命令**

Run:

```bash
cd web
bun test
bun run build
cd ../server
bun test
cd ..
git diff --check
```

Expected: frontend and server tests have 0 failures; only the existing production identity integration test may be skipped; production build exits 0; `git diff --check` reports no whitespace errors.

- [ ] **Step 4: 提交最终集成修复（仅在本任务产生的文件）**

```bash
git add web/src web/tests
git commit -m "perf: complete high performance canvas rendering"
```

- [ ] **Step 5: 交付前读取验证输出并记录实际结果**

Report exact pass/fail counts, browser actions performed, metrics observed, SVG fallback result, and any scale not actually benchmarked. Do not claim the 500/1,000 target without the Task 6 browser fixture evidence.

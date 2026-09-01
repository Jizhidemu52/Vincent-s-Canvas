# Canvas Reference Layout Implementation Plan
> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restyle the light canvas workbench into the reference layout: a slim top rail, compact left generator, large white dotted canvas, dense right media rail, mint selection, orange export, and violet 4K treatment.

**Architecture:** Keep the existing canvas state and generation handlers unchanged. Centralize visual tokens in `canvas-theme.ts`, retain `WirelessCanvas` as the viewport interaction surface, and rearrange the existing project composition plus toolbar/sidebar components.

**Tech Stack:** React 19, TypeScript, Tailwind utility classes, Ant Design, Bun test, Vite.

## Global Constraints

- Modify only the logged-in canvas workbench; do not change provider, generation payload, node data, asset URL, model configuration, or other page behaviour.
- Preserve light/dark theme selection; only redefine the light workbench visual system.
- Use mint only for selection/focus, orange only for export and primary forward actions, and violet outline only for high-resolution/4K treatment.
- Never rewrite user-uploaded/generated media.

---

### Task 1: Define light canvas visual tokens

**Files:**
- Modify: `web/src/lib/canvas-theme.ts`
- Modify: `web/src/components/canvas/wireless-canvas.tsx`
- Modify: `web/src/components/canvas/canvas-node.tsx`
- Create: `web/tests/canvas-workbench-theme.test.ts`

**Interfaces:**
- Consumes: `canvasThemes.light` through existing `useThemeStore` calls.
- Produces: light-theme tokens `toolbar.primary` and `toolbar.highResolution`; no new state.

- [ ] **Step 1: Write the failing visual-token test**

```ts
import { expect, test } from "bun:test";
import { canvasThemes } from "../src/lib/canvas-theme";

test("light canvas uses the reference white field and mint selection", () => {
    expect(canvasThemes.light.canvas.background).toBe("#fbfbfa");
    expect(canvasThemes.light.canvas.selectionStroke).toBe("#50d5be");
    expect(canvasThemes.light.canvas.dot).toBe("rgba(71,85,105,.12)");
});

test("light workbench reserves orange and violet for semantic emphasis", () => {
    expect(canvasThemes.light.toolbar.primary).toBe("#f36a2d");
    expect(canvasThemes.light.toolbar.highResolution).toBe("#805ad5");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/canvas-workbench-theme.test.ts`

Expected: FAIL because the current light tokens differ and the two toolbar semantic values do not exist.

- [ ] **Step 3: Implement the minimal theme and selection update**

```ts
canvas: {
    background: "#fbfbfa",
    dot: "rgba(71,85,105,.12)",
    line: "rgba(71,85,105,.07)",
    selectionStroke: "#50d5be",
    selectionFill: "rgba(80,213,190,.08)",
},
toolbar: {
    // retain existing toolbar fields
    primary: "#f36a2d",
    highResolution: "#805ad5",
},
```

Use 16px dot spacing and 0.85鈥?px dot size in light mode. Replace file-local blue selection values in `canvas-node.tsx` with `theme.canvas.selectionStroke`, including image borders, batch count text, resource badges, and connection handles.

- [ ] **Step 4: Verify focused test and typecheck**

Run: `bun test tests/canvas-workbench-theme.test.ts && bunx tsc --noEmit`

Expected: 2 tests pass and TypeScript exits 0.

- [ ] **Step 5: Commit**

```powershell
git add -- web/src/lib/canvas-theme.ts web/src/components/canvas/wireless-canvas.tsx web/src/components/canvas/canvas-node.tsx web/tests/canvas-workbench-theme.test.ts
git commit -m "feat: refine canvas light theme tokens"
```

### Task 2: Arrange the reference workbench layout

**Files:**
- Modify: `web/src/pages/canvas/project.tsx:3410-3902`
- Modify: `web/src/components/canvas/canvas-toolbar.tsx`
- Modify: `web/src/components/canvas/canvas-zoom-controls.tsx`
- Modify: `web/src/components/canvas/canvas-assets-sidebar.tsx`
- Create: `web/tests/canvas-workbench-layout.test.ts`

**Interfaces:**
- Consumes: existing callback props of `CanvasToolbar`, `CanvasAssetsSidebar`, `CanvasZoomControls`, `CanvasQuickGeneratePanel`, and `CanvasTopBar`.
- Produces: the same user actions, with CSS/layout-only changes.

- [ ] **Step 1: Write the failing composition test**

```ts
import { expect, test } from "bun:test";

test("workbench keeps reference rails and floating viewport controls", async () => {
    const project = await Bun.file("src/pages/canvas/project.tsx").text();
    const toolbar = await Bun.file("src/components/canvas/canvas-toolbar.tsx").text();
    const zoom = await Bun.file("src/components/canvas/canvas-zoom-controls.tsx").text();

    expect(project).toContain('data-testid="canvas-left-generator-rail"');
    expect(project).toContain('data-testid="canvas-right-asset-rail"');
    expect(toolbar).toContain('data-testid="canvas-top-tool-rail"');
    expect(zoom).toContain("bottom-5 right-5");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/canvas-workbench-layout.test.ts`

Expected: FAIL because layout hooks are absent and the viewport control is bottom-left.

- [ ] **Step 3: Reposition current controls without changing callbacks**

In `project.tsx`, add `data-testid="canvas-left-generator-rail"` to the existing left aside and `data-testid="canvas-right-asset-rail"` to `CanvasAssetsSidebar`. Use white surfaces, thin neutral borders, 224鈥?40px rails, and 12px padding. Keep `CanvasQuickGeneratePanel` embedded and vertical.

In `canvas-toolbar.tsx`, move the action dock from bottom-centre to the upper canvas area beneath the top bar. Add `data-testid="canvas-top-tool-rail"`, use a 40px white rail, and retain every existing `ToolbarButton` callback and appearance popover.

In `canvas-zoom-controls.tsx`, replace `bottom-5 left-5` with `bottom-5 right-5`, reduce the shell to 40px, and keep minimap/reset/slider/shortcut actions.

In `canvas-assets-sidebar.tsx`, use a 224px rail, 40px header, `grid-cols-2 gap-1.5`, warm-white tiles, neutral borders, and one-line labels while retaining filtering and insertion.

- [ ] **Step 4: Verify layout test and typecheck**

Run: `bun test tests/canvas-workbench-layout.test.ts && bunx tsc --noEmit`

Expected: test passes and TypeScript exits 0.

- [ ] **Step 5: Commit**

```powershell
git add -- web/src/pages/canvas/project.tsx web/src/components/canvas/canvas-toolbar.tsx web/src/components/canvas/canvas-zoom-controls.tsx web/src/components/canvas/canvas-assets-sidebar.tsx web/tests/canvas-workbench-layout.test.ts
git commit -m "feat: arrange canvas workbench reference layout"
```

### Task 3: Apply semantic emphasis and panel polish

**Files:**
- Modify: `web/src/pages/canvas/project.tsx:3954-4270`
- Modify: `web/src/components/canvas/canvas-node-prompt-panel.tsx`
- Modify: `web/src/components/canvas/canvas-node-hover-toolbar.tsx`
- Modify: `web/src/components/canvas/canvas-mini-map.tsx`
- Modify: `web/tests/canvas-workbench-theme.test.ts`

**Interfaces:**
- Consumes: `canvasThemes.light.toolbar.primary` and `canvasThemes.light.toolbar.highResolution`.
- Produces: visual-only styles for export, 4K/upscale, panel shells, and minimap.

- [ ] **Step 1: Extend the failing semantic-control test**

```ts
test("top bar and 4K tools use semantic workbench colors", async () => {
    const project = await Bun.file("src/pages/canvas/project.tsx").text();
    const hoverToolbar = await Bun.file("src/components/canvas/canvas-node-hover-toolbar.tsx").text();

    expect(project).toContain("theme.toolbar.primary");
    expect(hoverToolbar).toContain("theme.toolbar.highResolution");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/canvas-workbench-theme.test.ts`

Expected: FAIL because semantic tokens are not yet consumed by these controls.

- [ ] **Step 3: Implement the constrained polish**

Give the existing export button `background: theme.toolbar.primary`, white text, and a 6px radius; leave share neutral. Give the existing high-resolution/upscale action a 1px `theme.toolbar.highResolution` border and matching text colour only鈥攏o violet fill.

In `CanvasQuickGeneratePanel` and `CanvasNodePromptPanel`, replace orange-tinted section surfaces with white/`#f7f7f6`, 1px neutral borders, 8鈥?2px radii, and soft neutral shadows. Keep Generate orange and preserve disabled/error states.

In `CanvasMiniMap`, use a white shell, fine grey border, subtle shadow, and mint viewport outline without changing viewport calculations.

- [ ] **Step 4: Verify focused tests and build**

Run: `bun test tests/canvas-workbench-theme.test.ts tests/canvas-workbench-layout.test.ts && bun run build`

Expected: all focused tests pass and Vite exits 0.

- [ ] **Step 5: Commit**

```powershell
git add -- web/src/pages/canvas/project.tsx web/src/components/canvas/canvas-node-prompt-panel.tsx web/src/components/canvas/canvas-node-hover-toolbar.tsx web/src/components/canvas/canvas-mini-map.tsx web/tests/canvas-workbench-theme.test.ts
git commit -m "feat: polish canvas reference visual hierarchy"
```

### Task 4: Verify the real workflow

**Files:**
- Verify: `web/src/pages/canvas/project.tsx`
- Verify: `web/src/components/canvas/wireless-canvas.tsx`
- Verify: `web/src/components/canvas/canvas-assets-sidebar.tsx`
- Verify: `web/src/components/canvas/canvas-zoom-controls.tsx`

**Interfaces:**
- Consumes: completed visual tokens and workbench components.
- Produces: verification evidence only.

- [ ] **Step 1: Run the full frontend suite**

Run: `bun test`

Expected: zero failures.

- [ ] **Step 2: Build production client**

Run: `bun run build`

Expected: `tsc --noEmit && vite build` exits 0.

- [ ] **Step 3: Verify reference workflow in the in-app browser**

1. Sign in to the local test account and create a fresh canvas project.
2. Confirm top rail, left generator, dotted centre canvas, right media rail, and bottom-right zoom controls are simultaneously visible at desktop width.
3. Add an image node, select it, and verify a thin mint outline.
4. Enter a generator prompt, move focus to canvas, and re-open to confirm the existing prompt persistence still holds.
5. Click a right-rail thumbnail and verify it inserts a node.
6. Confirm export is visibly orange without exporting/downloading content.
7. Toggle dark mode then light mode to confirm both remain usable.

- [ ] **Step 4: Check whitespace**

Run: `git diff --check -- web/src/lib/canvas-theme.ts web/src/components/canvas/wireless-canvas.tsx web/src/components/canvas/canvas-node.tsx web/src/pages/canvas/project.tsx web/src/components/canvas/canvas-toolbar.tsx web/src/components/canvas/canvas-zoom-controls.tsx web/src/components/canvas/canvas-assets-sidebar.tsx web/src/components/canvas/canvas-node-prompt-panel.tsx web/src/components/canvas/canvas-node-hover-toolbar.tsx web/src/components/canvas/canvas-mini-map.tsx web/tests/canvas-workbench-theme.test.ts web/tests/canvas-workbench-layout.test.ts`

Expected: no output and exit 0.

- [ ] **Step 5: Commit verified work**

```powershell
git add -- web/src/lib/canvas-theme.ts web/src/components/canvas/wireless-canvas.tsx web/src/components/canvas/canvas-node.tsx web/src/pages/canvas/project.tsx web/src/components/canvas/canvas-toolbar.tsx web/src/components/canvas/canvas-zoom-controls.tsx web/src/components/canvas/canvas-assets-sidebar.tsx web/src/components/canvas/canvas-node-prompt-panel.tsx web/src/components/canvas/canvas-node-hover-toolbar.tsx web/src/components/canvas/canvas-mini-map.tsx web/tests/canvas-workbench-theme.test.ts web/tests/canvas-workbench-layout.test.ts
git commit -m "test: verify canvas workbench reference layout"
```

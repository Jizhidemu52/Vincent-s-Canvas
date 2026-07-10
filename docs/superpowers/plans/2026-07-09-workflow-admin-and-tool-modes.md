# Workflow Admin And Tool Modes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Strengthen the current React admin/canvas app with provider workflow templates, unified workflow management, real sidebar tool modes, and admin-visible batch/history records.

**Architecture:** Keep the existing React/Vite/Zustand admin structure. Add domain-level workflow/template helpers in `web/src/lib/admin-domain.ts`, expose them through `use-admin-store`, render a focused admin panel component, and let image/canvas pages read route query params for mode-specific behavior.

**Tech Stack:** React, TypeScript, Zustand, Ant Design, Bun tests, Vite.

---

### Task 1: Provider And Workflow Domain Model

**Files:**
- Modify: `web/src/lib/admin-domain.ts`
- Modify: `web/tests/admin-domain.test.ts`

- [ ] **Step 1: Write failing tests**

Add tests that expect default provider workflow templates, local workflow CRUD, public model templates without secrets, batch task creation, and tool-mode usage records.

Run: `bun test ./tests/admin-domain.test.ts`
Expected: FAIL because workflow helpers are not exported yet.

- [ ] **Step 2: Implement minimal domain helpers**

Add types and helpers:
- `AdminWorkflowTemplate`
- `AdminWorkflowConfig`
- `AdminToolMode`
- `createDefaultWorkflowTemplates`
- `createAdminWorkflow`
- `upsertAdminWorkflow`
- `deleteAdminWorkflow`
- `createBatchTaskFromToolMode`
- `createHistoryRecordFromToolMode`

- [ ] **Step 3: Verify tests pass**

Run: `bun test ./tests/admin-domain.test.ts`
Expected: PASS.

### Task 2: Store And Admin Workflow Panel

**Files:**
- Modify: `web/src/stores/use-admin-store.ts`
- Create: `web/src/pages/admin/components/workflow-management-panel.tsx`
- Modify: `web/src/pages/admin/index.tsx`

- [ ] **Step 1: Wire store actions**

Expose `workflowTemplates`, `workflows`, `saveWorkflow`, `deleteWorkflow`, `createBatchTaskFromToolMode`, and `createHistoryRecordFromToolMode`.

- [ ] **Step 2: Add admin tab**

Add a `workflows` tab named `工作流管理` showing RunningHub, ComfyUI, and local workflow templates with provider, capability, cost, status, and entry count.

- [ ] **Step 3: Verify admin route**

Run: `bun run build`
Expected: TypeScript and Vite build pass.

### Task 3: Real Sidebar Tool Modes

**Files:**
- Modify: `web/src/pages/image/index.tsx`
- Modify: `web/src/pages/canvas/index.tsx`

- [ ] **Step 1: Read query mode**

Use `tool` query param to map:
- `detail-enhance` to upscale/detail enhancement
- `image-edit` to inpaint/edit
- `angle-control` to structured angle control
- `gpt-chat` to canvas chat mode

- [ ] **Step 2: Show mode-specific workspace**

Change page titles, helper copy, operation type, project id, and quota estimate based on mode. Keep the existing generation UI.

- [ ] **Step 3: Verify browser behavior**

Open `/image?tool=detail-enhance`, `/image?tool=image-edit`, `/image?tool=angle-control`, and `/canvas?tool=gpt-chat`; each route should show a distinct visible mode.

### Task 4: Batch And History Bridge

**Files:**
- Modify: `web/src/pages/image/index.tsx`
- Modify: `web/src/lib/admin-domain.ts`
- Modify: `web/tests/admin-domain.test.ts`

- [ ] **Step 1: Connect image generation to batch metadata**

For multi-image or tool-mode submissions, record per-image batch items with waiting/processing/success/failed state and failure reason where available.

- [ ] **Step 2: Connect history to tool modes**

History records should use operation type and project id from the active tool mode so admin filters match the sidebar entry.

- [ ] **Step 3: Full verification**

Run: `bun test ./tests/admin-domain.test.ts`, `bun run build`, and browser route checks.

### Task 5: Publish

**Files:**
- Git metadata only

- [ ] **Step 1: Confirm remote**

Use `https://github.com/Jizhidemu52/Vincent-s-Canvas.git`, not the original upstream remote.

- [ ] **Step 2: Commit and push**

Commit source changes and push to the confirmed remote.

- [ ] **Step 3: Report validation**

Report commit hash, target branch, and verification results.

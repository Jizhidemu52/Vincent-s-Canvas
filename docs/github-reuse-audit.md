# GitHub Feature Reuse Audit

This project should not rebuild mature canvas, node, batch, asset, model, or provider features when an authorized GitHub implementation can be reused.

## Reuse Rule

- Prefer direct migration or adaptation of working modules over rewriting from scratch.
- Keep this repository as the main product shell.
- Before implementing a large canvas/workflow/provider feature, inspect GitHub for existing implementations and record the source, target feature, adaptation notes, and verification result here.
- Imported code must be reshaped to this product's current domain model, tests, API boundaries, and internal-account rules.

## Initial Authorized Sources

| Source | Reusable Areas | Target In This Product | Status |
| --- | --- | --- | --- |
| `basketikun/infinite-canvas` | Multi-canvas projects, infinite canvas interaction, node drag/resize, links, minimap, undo/redo, asset library, prompt library, AI workbench | Designer project canvas, assets, prompts, light workflow nodes | Audited 2026-06-28; reuse map below |
| `T8mars/T8-penguin-canvas` | Node workflow, batch execution, material collections, RunningHub/ComfyUI patterns, task logs | Batch mode, operation nodes, provider job logging | Audited 2026-06-28; reuse map below |
| `hero8152/Infinite-Canvas` | Multi-provider adapters, OpenAI/Gemini/RunningHub/ComfyUI/API patterns | Backend provider adapter layer | Audited 2026-06-28; reuse map below |

## GitHub Scouting Backlog

Search beyond the initial three repositories when a feature is not already covered:

- Infinite canvas rendering and viewport performance for many image nodes.
- Node graph editors with light dependency and React/Vite compatibility.
- Batch job queues with partial failure handling and retry state.
- Asset library search/tagging UX for internal design teams.
- OpenAI image, NanoBanana-style, RunningHub, and ComfyUI provider adapters.
- Credit/usage ledger patterns for internal tools.

## Current Local Baseline

The current repository already includes:

- Designer `Projects`, `History`, and `Profile`.
- Recraft-style project canvas with dropped/pasted image nodes.
- Left-panel and inline image model/prompt generation.
- Toolbar operations for upscale, remove background, download, save asset, magic edit, and mask edit.
- Lightweight workflow modules and connections.
- Batch import and processing.
- Backend-hosted provider registry, profile/history, admin credit adjustment, provider health, and persistence.
- Admin credit limits and model pricing controls.
- Admin generation job logs with designer, model, operation, status, cost, and project context.
- SQLite-backed platform tables for accounts, credit ledger, projects, nodes, connections, assets, generation history/jobs, model configs, audit logs, and idempotency requests.

## 2026-06-28 Source Audit

Authoritative public repo evidence checked on 2026-06-28:

- `basketikun/infinite-canvas` README describes an AI image creation workbench with canvas arrangement, AI image generation, reference image editing, assistant chat, prompt library, and asset accumulation. It also lists multi-canvas projects, node drag/resize, links, minimap, undo/redo, import/export, and prompt library in its core feature section.
- `T8mars/T8-penguin-canvas/package.json` identifies the project as an AI node canvas workflow tool for Web + Electron and declares `node-editor`, `workflow`, `runninghub`, `xyflow`, `sharp`, and related runtime dependencies.
- `hero8152/Infinite-Canvas` README/About says it supports ComfyUI, API calls, and ModelScope calls.

Local inspection notes:

- `basketikun/infinite-canvas` cloned successfully into a temporary audit folder. Useful directories found:
  - `web/src/components/canvas/`: canvas UI components, node panels, sidebars, dialogs, toolbar, stage/status components.
  - `web/src/stores/use-asset-store.ts`: asset store shape and local persistence patterns.
  - `web/src/services/image-storage.ts`, `web/src/services/file-storage.ts`, `web/src/services/app-sync.ts`: local image/file sync and persistence boundaries.
  - `web/src/services/api/image.ts`, `web/src/services/api/prompts.ts`: image-generation and prompt-fetching service boundaries.
  - `web/src/components/prompts/`: prompt selection/detail/card UI.
  - `canvas-agent/src/`: MCP/agent canvas control layer; useful later for internal assistant automation, not first-stage designer workflow.
- `T8mars/T8-penguin-canvas` tree inspection found mature workflow and provider modules:
  - `src/components/Canvas.tsx`, `CanvasManager.tsx`, `CanvasToolbar.tsx`, `NodeActionBar.tsx`.
  - `src/components/nodes/BatchProcessorNode.tsx`, `UploadNode.tsx`, `UpscaleNode.tsx`, `RemoveBgNode.tsx`, `RunningHubNode.tsx`, `ComfyUIAppMakerNode.tsx`, `RHToolsNode.tsx`.
  - `src/config/nodeRegistry.ts`, `src/config/portTypes.ts`.
  - `src/utils/batchProcessor.ts`, `topologicalSort.ts`, `nodePlacement.ts`, `nodeResizeBehavior.ts`, `outputMaterialPersistence.ts`, `workflowResource.ts`.
  - `backend/src/providers/comfyui.js`, `openaiCompatible.js`, `modelscope.js`, `registry.js`, `backend/src/routes/externalProviders.js`, `imageOps.js`.
  - `tests/batchProcessor.test.ts`, `comfyuiProvider.test.ts`, `openaiCompatibleProvider.test.ts`, `generationHistory.test.ts`, `workflowResource.test.ts`.
- `hero8152/Infinite-Canvas` tree inspection found provider-oriented modules:
  - `main.py`: monolithic FastAPI/Python application containing provider and canvas routes.
  - `static/js/api-settings.js`, `static/js/comfyui-settings.js`, `static/js/canvas.js`, `static/js/history-bulk-manager.js`.
  - `static/runninghub/api_providers.json`, `workflows/*.json`.
  - `static/api-settings.html`, `static/comfyui-settings.html`, `static/asset-manager.html`, `static/canvas-list.html`.

## Migration Decisions

| Target Need | Prefer Source | Candidate Modules | Decision |
| --- | --- | --- | --- |
| Prompt library UI and prompt detail/selection behavior | `basketikun/infinite-canvas` | `web/src/components/prompts/*`, `web/src/services/api/prompts.ts` | Adapt into current `RightDock` prompt library before expanding custom prompt UX. |
| Asset persistence/search and image storage boundaries | `basketikun/infinite-canvas` | `use-asset-store.ts`, `image-storage.ts`, `file-storage.ts`, `app-sync.ts` | Adapt storage ideas to backend-owned assets; do not keep front-end-only API keys. |
| Workflow node registry and port typing | `T8mars/T8-penguin-canvas` | `src/config/nodeRegistry.ts`, `src/config/portTypes.ts`, node components | Use as the next source for a typed operation registry instead of expanding ad hoc module checks. |
| Batch workflow behavior and partial failure tests | `T8mars/T8-penguin-canvas` | `BatchProcessorNode.tsx`, `batchProcessor.ts`, `tests/batchProcessor.test.ts` | Reuse queue semantics and tests when adding retries/progress/cancel. |
| RunningHub/ComfyUI provider adapters | `T8mars/T8-penguin-canvas`, `hero8152/Infinite-Canvas` | T8 backend provider files; hero settings/workflow JSON | Start from T8 provider registry and tests, then cross-check hero settings screens/workflow fixtures. |
| API/provider settings UI | `hero8152/Infinite-Canvas` | `static/js/api-settings.js`, `static/js/comfyui-settings.js`, related HTML | Reuse field set and connection-test ideas, but keep secrets server-side in this product. |
| History bulk management | `hero8152/Infinite-Canvas` | `static/js/history-bulk-manager.js` | Use as reference after current team history has filtering, selection, and export needs. |

## Next Reuse-First Implementation Order

1. Migrate a typed node operation registry inspired by T8 `nodeRegistry` and `portTypes` so `Generate/Edit/Upscale/Remove BG/Batch/Upload Reference` are declared once and consumed by toolbar, picker, plan validation, and API routing.
2. Adapt T8 batch queue semantics for retry, cancel, and per-item progress while preserving current project canvas and credit ledger.
3. Adapt basketikun prompt library UI patterns into the current prompt dock, keeping server-side prompt presets and designer attribution.
4. Add RunningHub and ComfyUI live-ready provider adapters by porting T8 provider registry tests and reconciling hero workflow JSON/settings fields.
5. Use hero history bulk management ideas for admin/team history filtering and export after real provider output storage is stable.

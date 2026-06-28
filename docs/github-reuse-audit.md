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
- Recraft-style project canvas with dropped/pasted image nodes and basketikun-style clickable minimap navigation.
- Left-panel and inline image model/prompt generation.
- Toolbar operations for upscale, remove background, download, save asset, magic edit, and mask edit.
- Basketikun-inspired asset dock reuse flow with saved asset insertion and tag filtering.
- Lightweight workflow modules and connections.
- Typed first-pass workflow module registry for `Generate / Edit / Upscale / Remove BG / Batch / Upload Reference`, including backend API path mapping, input/output port definitions, selected-node inspector summaries, strict connection compatibility, compatible module picker filtering with target port labels, drag-time compatible/incompatible connection highlighting, port-level input/output target feedback, true port-specific drop connections, connected text-port prompt execution, connected image/result-port reference execution, connected config-port output-count execution, typed batch settings handoff for concurrency/failure policy, typed edit mask config handoff, and typed provider request settings for size/quality/preset.
- Batch import and processing.
- T8-inspired batch queue status summaries, failed-item retry batches, cancellation, merge-safe retry results, backend stop-on-failure execution, skipped-item queue status, batch settings propagation into generation requests, and tested concurrency-limited batch submission.
- Basketikun-inspired prompt library service boundary with backend-owned designer prompt presets, attribution, prompt detail cards, and canvas note handoff.
- Backend-hosted provider registry, profile/history, admin credit adjustment, provider health, provider payload mapping, live-ready execution boundary, HTTP live/mock routing, provider progress snapshots, node-level provider progress metadata, selected-node provider progress display, provider error normalization, multi-provider success/partial-success output normalization, and persistence.
- Admin credit limits and model pricing controls.
- Admin generation job logs with designer, model, operation, status, cost, and project context.
- Hero-inspired admin team history filtering and filtered JSON export for audit handoff.
- Hero-inspired designer history project filtering for project-level generation traceability.
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
| Infinite canvas minimap navigation | `basketikun/infinite-canvas` | `web/src/components/canvas/*`, canvas stage/status components | Adapted the existing local minimap into accessible node-jump controls on 2026-06-28; designers can select and center a distant node from the minimap without replacing the current canvas implementation. |
| Prompt library UI and prompt detail/selection behavior | `basketikun/infinite-canvas` | `web/src/components/prompts/*`, `web/src/services/api/prompts.ts` | Adapted backend prompt API boundary, designer attribution, detail preview cards, direct prompt insertion, and prompt-to-canvas-note handoff on 2026-06-28; richer prompt organization remains later. |
| Asset persistence/search and image storage boundaries | `basketikun/infinite-canvas` | `use-asset-store.ts`, `image-storage.ts`, `file-storage.ts`, `app-sync.ts` | Adapted asset tag filtering in the canvas dock on 2026-06-28 using existing backend-owned `LibraryAsset.tags`; deeper asset search, folders, and image storage boundaries remain later. |
| Workflow node registry and port typing | `T8mars/T8-penguin-canvas` | `src/config/nodeRegistry.ts`, `src/config/portTypes.ts`, node components | Adapted first-pass typed module registry, backend endpoint mapping, port definitions, inspector port summaries, strict connection compatibility, compatible module picker filtering, target port labels, drag-time compatible/incompatible highlights, port-level input/output target feedback, true port-specific drop connections, connected text-port prompt execution, connected image/result-port reference execution, connected config-port output-count execution, typed batch settings handoff for concurrency/failure policy, typed edit mask config handoff, typed provider request settings for size/quality/preset, and provider payload mapping on 2026-06-28; next step is live adapter execution. |
| Batch workflow behavior and partial failure tests | `T8mars/T8-penguin-canvas` | `BatchProcessorNode.tsx`, `batchProcessor.ts`, `tests/batchProcessor.test.ts` | Adapted lightweight retry/progress/cancel semantics, backend stop-on-failure submission, and concurrency-limited batch runner into current batch queue on 2026-06-28; deeper async worker persistence and pause/resume remain later. |
| RunningHub/ComfyUI provider adapters | `T8mars/T8-penguin-canvas`, `hero8152/Infinite-Canvas` | T8 backend provider files; hero settings/workflow JSON | Adapted first-pass OpenAI/NanoBanana image payload, RunningHub/ComfyUI workflow payload mapping, live HTTP submission, polling, output normalization, HTTP generation routing by provider mode, provider progress snapshots, node-level provider progress metadata and context display, provider-specific error normalization, NanoBanana base64 outputs, nested workflow asset outputs, and partial-success item error reporting on 2026-06-28; next step is deeper provider-specific fixtures and real async worker persistence. |
| API/provider settings UI | `hero8152/Infinite-Canvas` | `static/js/api-settings.js`, `static/js/comfyui-settings.js`, related HTML | Reuse field set and connection-test ideas, but keep secrets server-side in this product. |
| History bulk management | `hero8152/Infinite-Canvas` | `static/js/history-bulk-manager.js` | Adapted filtered admin team history export and designer-side project history filtering on 2026-06-28 so managers and designers can trace generation records by account/project; bulk selection, CSV export, and delete/archive operations remain later. |

## Next Reuse-First Implementation Order

1. Extend the current T8-inspired batch queue with persistent async worker state, pause/resume, and persistent provider job progress after live provider execution is connected.
2. Add deeper RunningHub and ComfyUI workflow fixtures by porting T8 provider registry tests and reconciling hero workflow JSON/settings fields.
3. Expand basketikun-style asset and prompt organization with asset search/folders, prompt categories, favorites, and richer card metadata now that asset tag filtering and prompt detail handoff exist.
4. Use hero history bulk management ideas for admin/team history bulk selection, CSV export, and archive/delete operations after real provider output storage is stable.

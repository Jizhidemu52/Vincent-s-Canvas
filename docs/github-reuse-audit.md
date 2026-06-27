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
| `basketikun/infinite-canvas` | Multi-canvas projects, infinite canvas interaction, node drag/resize, links, minimap, undo/redo, asset library, prompt library, AI workbench | Designer project canvas, assets, prompts, light workflow nodes | To audit before next canvas expansion |
| `T8mars/T8-penguin-canvas` | Node workflow, batch execution, material collections, RunningHub/ComfyUI patterns, task logs | Batch mode, operation nodes, provider job logging | To audit before workflow/provider expansion |
| `hero8152/Infinite-Canvas` | Multi-provider adapters, OpenAI/Gemini/RunningHub/ComfyUI/API patterns | Backend provider adapter layer | To audit before live provider wiring |

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

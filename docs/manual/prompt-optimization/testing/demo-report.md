# Demo prompt runtime integration verification

Completed 2026-10-25. This worker used only local fixture providers; no paid requests, commits, publication, or deployment were performed by this worker. Root-coordinated live QA is separate evidence.

## Delivered behavior

- `server/src/demo-prompt-runtime.ts` uses the shared compiler, immutable recipe versions, model-binding fingerprints, source-byte validation, cache/compilation checks, safe errors, and internal usage accounting. Source ownership is checked before materializing a stored image BLOB.
- `server/src/demo-server.ts` loads private creative-chat/canvas-assistant profiles from the active SQLite recipes. Private calls are buffered, non-thinking, server-tool-defined, validated before return, and omit internal usage. Missing or disabled recipes fail closed.
- Single-task admission compiles structured `promptInput` before image task creation. Stored/queryable task data includes the final visible prompt, original `userInput`, and `optimized`; public JSON removes internal submission hashes and redundant `promptCompilationId`, retaining opaque `userInput.compilationId`/`parameters.promptOptimization.compilationId`.
- Batch admission compiles once using the first item's references, then calls the private in-process task admission function. There is no HTTP/client trusted flag. In-process concurrent duplicates share one response; changed inputs under the same request ID fail with 409.
- `server/src/demo-prompt-batches.ts` durably records admission state in the same SQLite database. `GET /api/tasks/batches/by-request/:requestId` returns `batchId`, per-item tasks/indexes, failures, visible prompt, optimized state, `totalItems`, and `submissionComplete`. Restart marks unfinished admission interrupted and reports missing items without re-submitting unknown work.
- Existing Demo global `/api/admin/*` 403 behavior is preserved. The public compilation API is available; admin recipe adapter contracts are implemented and directly tested but do not bypass or introduce Demo login/role elevation.
- `server/src/demo-prompt-recipes.ts` now finalizes every prepared statement in `finally`; tests demonstrated that the previous implementation left Windows database files busy after close. The fix is in production code, with no forced-GC test workaround.

## Import and configuration boundary

Recipes, versions, compilations, and Demo batch admission records all use the exact file selected by `DEMO_STATE_PATH`. Startup does not automatically import or activate source rules, so it does not overwrite later admin versions. Import is explicit:

```powershell
bun server/scripts/import-prompt-recipes.ts --file 'docs/manual/prompt-optimization/无线画布-板块系统提示词（机密）.md' --sqlite '<absolute DEMO_STATE_PATH>' --model '<enabled server chat model configuration UUID>' --activate
```

The import contains 18 recipes, including two chat supplements, and is idempotent. Later active versions, edited settings, model bindings, and disabled state are not replaced by re-import. Demo Mark GPT-6 configuration UUID is `d5000000-0000-4000-8000-000000000004`; Mark Sonnet configuration UUID is `d5000000-0000-4000-8000-000000000010`. These are configuration identifiers, not keys.

## Verification

- Existing Demo chat/provider/model/batch regressions plus new prompt suites and shared compiler: 24 tests, 319 assertions, all passed across 8 files.
- After the actual statement-finalization fix and removal of the temporary test cleanup workaround, reran `demo-prompt-runtime.test.ts`, `demo-prompt-http.test.ts`, and `prompt-compiler.test.ts`: 18 tests, 179 assertions, all passed.
- Real child Demo process over loopback HTTP and file-backed SQLite verified concurrent single task creates one optimizer call and one image call; required-scene bypass attempts and changed compilation input are rejected; invalid/leaking optimizer output creates no image task; chat rule leakage is rejected before return; a two-image batch makes one optimizer call; restart plus query/re-POST does not add model calls; a new same-input compile request reuses persisted cache; failed batch compilation creates no child tasks; disabling a recipe stops new generation; provider token counts and unknown monetary cost are recorded without fabricated actual cost.
- Direct runtime tests verify reference authorization before byte reads, actual MIME validation, administrator-only adapter contracts, all 18 imported recipes, edited-version persistence, concurrent request gating, and interrupted batch reporting/owner isolation.
- `server`: `bunx tsc --noEmit` passed after all production and test changes.
- Scoped `git -c core.whitespace=cr-at-eol diff --check` passed.

## Boundaries

- The local fixture tests establish control flow, persistence, isolation, and protocol behavior; they do not establish real-provider visual quality or every provider's response behavior.
- Deterministic leakage checks block copied long rules and known formats, not every possible semantic paraphrase or novel encoding.
- The deployed production path is the PostgreSQL API plus worker, not Demo. Its deployment and paid quality checks belong to root integration.
- No new Demo admin login is provided. Use the formal authenticated API for browser-based admin maintenance; Demo import stays explicit CLI-only while the existing admin gate is active.

# Chat profile migration verification

Completed 2026-10-25; no paid provider requests, commits, publication, or deployment.

## Changes

- `server/src/prompt-chat-profiles.ts` owns creative-chat/canvas-assistant rules, tool schemas, image-contract repair rules, English image-prompt translation rules, and media-evidence guidance. It combines these immutable code contracts with the active DB recipe suffix. Profile/tool-key mismatch, missing recipe, client system messages, or invalid bounded context fail before submission.
- Frontend chat entry points send only profile discriminators, original user messages, previews, identifiers, saved targets, defaults, and other evidence. Existing executable edit contracts, source validation, image lineage, preview budgets, and original/latest base-selection algorithms remain client-side and unchanged. Schema/base-policy tests moved to the server; behavior tests remain on the frontend.
- Private profile calls are buffered, non-streaming, and request non-thinking mode. Visible text, tool arguments (including Unicode-escaped JSON), and replay channels are checked before return. Readable Responses summaries are removed; opaque encrypted reasoning and empty signed Claude thinking/redaction tokens survive. Required nonempty plaintext Claude thinking fails explicitly with `CHAT_PRIVATE_THINKING_UNSUPPORTED` rather than breaking a signed continuation.
- `server/src/routes/chat.ts` exposes internal usage metadata for the prompt compiler. Counts and actual cost are provider-reported only; unavailable values remain absent. Public chat HTTP responses omit usage metadata. Usage history receives the original client messages, never injected system rules; upstream errors suppress private request echoes.

## Verification

- `server`: `bunx tsc --noEmit` passed.
- `web`: `bunx tsc --noEmit` passed.
- Server chat protocol/profile/usage regression group: 193 tests passed across 10 files. Additional private-profile HTTP route tests: 6 passed. Latest focused profile/route/usage rerun: 41 passed.
- Web creative-chat, canvas image-edit contracts, assistant context/history/output/dispatch/render regression group: 299 passed across 10 files. Includes real component dispatch harnesses for multi-image ordering, original/result correction, unchanged reruns, contract preflight repair, cancellation, and provider-call counts.
- Scoped `git -c core.whitespace=cr-at-eol diff --check` passed; only expected line-ending warnings.
- Static source check asserts server rule/tool-schema markers are absent from the migrated frontend files.

## Boundaries

- No real provider behavior or quality was inferred from mocked/local fixture results. Deployment still needs the active recipe loader and usable model bindings.
- Leakage checks are deterministic long-passage/pattern checks plus channel sanitization, not a proof against every semantic paraphrase or encoding attack.
- OpenAI/APIMart/Gemini/Anthropic usage field handling was checked against official usage/token documentation; no monetary estimate is presented as actual cost. Sources: https://developers.openai.com/api/docs/guides/token-counting ; https://platform.claude.com/docs/en/build-with-claude/token-counting ; https://ai.google.dev/api/generate-content .
- Demo integration is the next separately assigned task; it is not included in the completed chat route verification above.

# OpenToken GPT-Image-2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Configure OpenToken as the secure OpenAI-compatible provider for the `gpt-image-2` image-generation and reference-image editing paths.

**Architecture:** Production continues to use the encrypted provider configuration and generic OpenAI-compatible worker. The local demo adds a small OpenToken adapter: ordinary requests call `/images/generations`, and requests with reference assets call `/images/edits` as multipart form data. The API key is process-only and is never returned to the browser or written to a file.

**Tech Stack:** React admin UI, Express API, PostgreSQL provider/model configuration, AES-256-GCM provider credential encryption, OpenAI-compatible OpenToken API.

## Global Constraints

- Use model ID exactly `gpt-image-2`.
- Use base URL exactly `https://cn2.gw.opentoken.io/v1`.
- Store the API key only through the server-side provider credential form/API; never commit, log, or expose it to the browser.
- Do not configure a provider API key unless the server reports `PROVIDER_ENCRYPTION_KEY` is available.
- Preserve existing provider, model, workflow, pricing, and tool configuration records unless this plan explicitly updates a target mapping.
- Verify both the normal generation and reference-image edit user paths using a low-cost, single-image request.

---

### Task 1: Verify the destination environment and obtain an OpenToken API key

**Files:**
- Read: `server/src/routes/model-configuration.ts:14-62`
- Read: `web/src/pages/admin/components/api-provider-panel.tsx:1-74`
- Modify: OpenToken tenant configuration and the running application's encrypted provider configuration (runtime data only)

**Interfaces:**
- Consumes: an OpenToken tenant administrator session and a running canvas session with `super_admin` role.
- Produces: an OpenToken API key available only for the provider save action; no repository file or terminal output contains the value.

- [ ] **Step 1: Check the server can encrypt provider credentials**

Open the application's super-admin provider page and confirm the API key field is present. If saving any provider with credentials returns `SECRET_KEY_NOT_CONFIGURED`, stop and configure a valid 32-byte base64 `PROVIDER_ENCRYPTION_KEY` in the server deployment before continuing. Do not enter an OpenToken key into a server that cannot encrypt it.

- [ ] **Step 2: Create a scoped API key in OpenToken**

In the OpenToken tenant console, first confirm `gpt-image-2` is enabled in the model marketplace. Create a new API key dedicated to this canvas deployment. Label it `vincent-canvas-gpt-image-2`; restrict it to the canvas server IP address if the tenant has IP allowlisting. Copy the key directly into the canvas provider form without pasting it into source files, chat messages, command history, or documentation.

- [ ] **Step 3: Verify the key never becomes visible in the application**

After the provider is saved in Task 2, reload the provider list. Expected user-visible result: the provider shows an encrypted-credentials status only; the API key value and any key fragment are not displayed.

- [ ] **Step 4: Record no secret-bearing artifacts**

Run:

```powershell
git status --short
```

Expected: no file containing an OpenToken API key is staged or untracked.

### Task 2: Configure the OpenToken provider and GPT-Image-2 model

**Files:**
- Read: `server/src/routes/model-configuration.ts:14-154`
- Read: `server/src/worker.ts:170-251`
- Modify: provider, model, and tool-configuration records through `/api/admin/model-configuration/*` (runtime data only)

**Interfaces:**
- Consumes: the API key from Task 1 and the application super-admin session.
- Produces: enabled `OpenToken` provider and enabled `gpt-image-2` model with `generate` and `edit` capabilities.

- [ ] **Step 1: Create or update the provider**

In Admin → API Providers, create `OpenToken` (or update the existing OpenToken record) with:

```json
{
  "name": "OpenToken",
  "protocol": "openai",
  "baseUrl": "https://cn2.gw.opentoken.io/v1",
  "enabled": true,
  "credentials": { "apiKey": "<enter only in the password field>" }
}
```

Expected: the saved provider is enabled, displays the specified base URL, and reports that credentials are configured without disclosing their value.

- [ ] **Step 2: Create or update the model**

In Admin → Model Configuration, create or update the model under the OpenToken provider with:

```json
{
  "name": "GPT Image 2",
  "modelId": "gpt-image-2",
  "capabilities": ["generate", "edit"],
  "creditCost": 0,
  "rmbCost": 0,
  "concurrencyLimit": 1,
  "enabled": true
}
```

Use the site's existing approved credit and cost values instead of changing financial rules if an existing GPT Image 2 entry already supplies them. Expected: the public model list contains one enabled `gpt-image-2` entry associated with OpenToken.

- [ ] **Step 3: Bind existing image tools to the configured model**

Set the `image` tool mapping to this model. Set `image-edit` and `angle-control` to this model only when their existing usage policy permits reference-image editing through OpenToken; leave unrelated tools unchanged. Expected: the image model picker offers GPT Image 2, and the mapped tools report a provider with configured credentials.

- [ ] **Step 4: Verify configuration visibility without secret disclosure**

Request the existing public model endpoint while authenticated:

```http
GET /api/models
```

Expected response includes a model with `modelId: "gpt-image-2"` and `generate`/`edit` capabilities. It must not include `apiKey`, `encrypted_credentials`, or any OpenToken key material.

- [ ] **Step 5: Commit repository artifacts if any were created**

Run:

```powershell
git status --short
```

Expected: configuration has changed only in runtime storage; commit only intentional non-secret documentation or code changes. Do not create a commit merely for runtime configuration.

### Task 3: Verify user-visible generation and reference-editing behavior

**Files:**
- Read: `server/src/worker.ts:170-251`
- Read: `web/src/pages/image/index.tsx:176-252`
- Read: `web/src/components/model-picker.tsx:1-40`
- Modify: generated task/history records and stored output assets only (runtime data created by the test)

**Interfaces:**
- Consumes: the enabled OpenToken provider/model configuration from Task 2 and a non-administrative canvas user session.
- Produces: one completed generation task and one completed edit task whose recorded model ID is `gpt-image-2`.

- [ ] **Step 1: Verify the normal image-generation path**

From the standard image page, select `GPT Image 2`, set output count to one, and submit the prompt `一枚蓝色陶瓷纽扣，纯白背景，商品摄影`. Expected: the request goes to `https://cn2.gw.opentoken.io/v1/images/generations` with `model: "gpt-image-2"`; the UI shows one generated image and the task history records success against `gpt-image-2`.

- [ ] **Step 2: Verify the reference-image editing path**

Upload a non-sensitive sample image, select `GPT Image 2`, and submit `保持主体不变，将背景改为浅灰色摄影棚背景`. Expected: the request goes to `https://cn2.gw.opentoken.io/v1/images/edits` as multipart form data with `model: "gpt-image-2"`, prompt, and the reference image; the UI shows an edited output and history records success against `gpt-image-2`.

- [ ] **Step 3: Verify an input failure has no success side effect**

Submit the image form without a prompt. Expected: client-side validation prevents submission or shows a clear prompt-required message, no upstream request occurs, and no successful task/history record is added.

- [ ] **Step 4: Verify an upstream authentication failure is recoverable**

Use the application’s provider test/staging environment with an intentionally invalid duplicate provider key, never the production provider record. Submit one single-image generation. Expected: the UI reports an upstream authorization failure, records the task as failed (not successful), produces no output asset, and the production OpenToken credential remains unchanged.

- [ ] **Step 5: Review the resulting configuration and audit history**

Confirm the provider/model/tool configuration and the two successful task records all identify `gpt-image-2`. Confirm that audit/history details do not contain the API key, OpenToken tenant password, or raw authorization header.

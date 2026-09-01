# Chat Multiformat Attachments Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the LLM chat page accept, locally parse, display and send PDF, Excel, Word, text/code and image attachments.

**Architecture:** Add a focused browser-only attachment parser module. The chat page delegates type detection and parsing to it, then appends parsed text to message content while preserving image data URLs as multimodal blocks.

**Tech Stack:** React, TypeScript, Bun tests, PDF.js, SheetJS, Mammoth.

## Global Constraints

- Parse files locally in the browser; never send raw PDF, Excel or Word binaries to a third-party parser.
- Accept at most five files, 5MB per file and 8MB total.
- Truncate extracted text at 80,000 characters and mark it as truncated.
- Preserve current image compression and image-message behavior.

---

### Task 1: Attachment type policy and text safety

**Files:**
- Create: `web/src/lib/chat-attachments.ts`
- Create: `web/tests/chat-attachments.test.ts`

**Interfaces:**
- Produces `parseChatAttachment(file: File): Promise<ParsedChatAttachment>`.
- Produces `isSupportedChatAttachment(file: Pick<File, "name" | "type">): boolean`.
- Produces `MAX_CHAT_ATTACHMENT_TEXT_LENGTH = 80_000`.

- [ ] **Step 1: Write failing tests for extensions and truncation**

```ts
expect(isSupportedChatAttachment({ name: "销售表.xlsx", type: "" })).toBe(true);
expect(isSupportedChatAttachment({ name: "材料.pdf", type: "application/pdf" })).toBe(true);
expect(isSupportedChatAttachment({ name: "download.py", type: "text/x-python" })).toBe(true);
expect(isSupportedChatAttachment({ name: "archive.zip", type: "application/zip" })).toBe(false);
expect(truncateChatAttachmentText("a".repeat(80_001)).truncated).toBe(true);
```

- [ ] **Step 2: Run the test and verify it fails because the parser module is absent**

Run: `bun test tests/chat-attachments.test.ts`

- [ ] **Step 3: Implement the type policy, extraction result type and truncation helper**

```ts
export type ParsedChatAttachment = { kind: "image" | "text"; name: string; mimeType: string; size: number; dataUrl?: string; textContent?: string; truncated?: boolean };
export function truncateChatAttachmentText(text: string) { /* return marked 80,000-character text */ }
```

- [ ] **Step 4: Run the focused test and verify it passes**

Run: `bun test tests/chat-attachments.test.ts`

### Task 2: Browser parsers for PDF, Excel and Word

**Files:**
- Modify: `web/package.json`
- Modify: `web/src/lib/chat-attachments.ts`
- Modify: `web/tests/chat-attachments.test.ts`

**Interfaces:**
- `parseChatAttachment` returns named text sections for each PDF page, Excel worksheet and Word body.

- [ ] **Step 1: Add failing parser-contract tests using small in-memory text fixtures and parser adapters**

```ts
expect(formatWorkbookText([{ name: "销售", rows: [["日期", "金额"], ["2026-08-13", 100]] }])).toContain("[工作表：销售]");
expect(formatPdfText(["第一页", "第二页"])).toContain("[第 2 页]");
```

- [ ] **Step 2: Run the test and verify the formatter exports are missing**

Run: `bun test tests/chat-attachments.test.ts`

- [ ] **Step 3: Add `pdfjs-dist`, `xlsx` and `mammoth`; implement local parsers and formatters**

```ts
if (extension === "pdf") return textAttachment(file, await extractPdfText(file));
if (["xlsx", "xls"].includes(extension)) return textAttachment(file, await extractWorkbookText(file));
if (extension === "docx") return textAttachment(file, await extractDocxText(file));
```

- [ ] **Step 4: Run parser tests and production build**

Run: `bun test tests/chat-attachments.test.ts && bun run build`

### Task 3: Connect the unified parser to LLM chat UI

**Files:**
- Modify: `web/src/pages/chat/index.tsx`
- Modify: `web/tests/chat-attachments.test.ts`

**Interfaces:**
- `addFiles` calls `parseChatAttachment` for every allowed file.
- `ChatAttachment` uses `ParsedChatAttachment` fields and preserves parsed-text metadata.

- [ ] **Step 1: Write a failing UI-input policy test for the `.xlsx`, `.pdf`, `.docx` and code extensions**

```ts
expect(CHAT_ATTACHMENT_ACCEPT).toContain(".xlsx");
expect(CHAT_ATTACHMENT_ACCEPT).toContain(".pdf");
expect(CHAT_ATTACHMENT_ACCEPT).toContain(".docx");
expect(CHAT_ATTACHMENT_ACCEPT).toContain(".py");
```

- [ ] **Step 2: Run the test and verify the exported accept policy is absent**

Run: `bun test tests/chat-attachments.test.ts`

- [ ] **Step 3: Replace page-local parsing with the module, expand the file input accept policy and show parsed/truncated state**

```tsx
const parsed = await parseChatAttachment(file);
next.push({ id: crypto.randomUUID(), ...parsed });
<span>{attachment.truncated ? "内容已截断" : attachment.textContent ? "已解析" : "图片"}</span>
```

- [ ] **Step 4: Run focused tests, complete web test suite and build**

Run: `bun test tests/chat-attachments.test.ts && bun test && bun run build`

### Task 4: Local end-to-end verification

**Files:**
- Verify only: `web/src/pages/chat/index.tsx`

- [ ] **Step 1: Use the local page to choose `.xlsx`, `.pdf`, `.py` and `.png` files**

- [ ] **Step 2: Verify all four appear in the attachment tray, PDF/Excel/code show parsed status, and image shows a thumbnail**

- [ ] **Step 3: Send a short LLM request and verify the output can reference file content without displaying a raw-binary or unsupported-format error**

- [ ] **Step 4: Verify oversized, unsupported and sixth-file inputs preserve already accepted attachments and display an actionable error**

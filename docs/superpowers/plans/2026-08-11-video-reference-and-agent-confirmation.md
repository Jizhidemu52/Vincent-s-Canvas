# Video Reference and Agent Confirmation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make HappyHorse image-to-video accept canvas reference images reliably and ensure video generation proposed by Agent is presented for confirmation.

**Architecture:** The local demo server will serialize stored image bytes into valid data URLs for HappyHorse instead of re-uploading multipart data. The Agent system instruction will explicitly require a video-generation tool call for an unambiguous video request with an available image reference; existing write-tool confirmation then presents it as a pending approval.

**Tech Stack:** Bun, TypeScript, React, bun:test, APIMart HappyHorse API.

## Global Constraints

- Preserve existing HappyHorse text, first-frame, reference-image, and video-edit routing.
- Do not expose provider credentials in code, tests, logs, or UI.
- A generation request remains a writable Agent operation and requires confirmation when the toggle is on.

---

### Task 1: Serialize HappyHorse reference images as data URLs

**Files:**
- Modify: `server/src/demo-server.ts`
- Test: `server/tests/demo-server-video.test.ts`

- [ ] Write a failing test for an image asset becoming `data:image/png;base64,...` without a multipart upload.
- [ ] Run the focused test and confirm it fails because no serializer exists.
- [ ] Add the smallest helper that validates the image MIME type and serializes the bytes; route `first_frame_image` and `image_urls` through it.
- [ ] Run the focused test and then the server test suite.

### Task 2: Make video approval deterministic for explicit Agent requests

**Files:**
- Modify: `web/src/components/canvas/canvas-assistant-panel.tsx`
- Test: `web/src/components/canvas/canvas-assistant-panel.test.ts`

- [ ] Write a failing test that classifies `canvas_generate_video` as a writable tool call.
- [ ] Run the focused test and confirm the behavior is covered.
- [ ] Strengthen the Agent instruction so an explicit video request with a real image node calls `canvas_generate_video` using that node as reference.
- [ ] Run the focused test and frontend test suite/build.

### Task 3: Validate the end-to-end local user path

- [ ] Restart the local API with its existing configured credentials.
- [ ] From the canvas Agent, request a video using an available image node and confirm a pending approval card is visible.
- [ ] Approve the operation and verify the provider accepts the reference image instead of returning the malformed MIME error.

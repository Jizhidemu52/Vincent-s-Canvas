# Vincent-s-Canvas

Internal infinite-canvas image workflow tool for designer teams.

## Run

```bash
npm install
npm run dev
npm run api
```

`npm run dev` starts the Vite client. `npm run api` starts the backend-hosted mock model API at `http://127.0.0.1:8787` by default.

## Backend API

The browser UI should never store provider API keys. Model calls are routed through the server layer:

- `GET /api/models`
- `GET /api/profile`
- `GET /api/history`
- `GET /api/admin/audit`
- `GET /api/admin/usage`
- `GET /api/admin/providers`
- `POST /api/generations`
- `POST /api/edits`
- `POST /api/upscale`
- `POST /api/remove-bg`

Write endpoints accept a `GenerationRequest` body and optional `x-request-id` header for duplicate-submit protection. The mock adapter returns the same `GenerationResult` shape that real GPT Image, NanoBanana, RunningHub, ComfyUI, or internal model adapters should return later.

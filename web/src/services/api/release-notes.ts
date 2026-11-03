import type { AdminReleaseNote, PublicReleaseNote, ReleaseNoteDraftInput, ReleaseNotesPage } from "../../../../shared/release-notes";

export type { AdminReleaseNote, PublicReleaseNote } from "../../../../shared/release-notes";

export class ReleaseNotesError extends Error {
    constructor(message: string, readonly status: number, readonly code?: string) { super(message); }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
    const timeout = AbortSignal.timeout(15_000);
    const response = await fetch(path, { ...init, signal: init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout, credentials: "include", cache: "no-store", headers: { "content-type": "application/json", ...init?.headers } });
    if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new ReleaseNotesError(body.message || "版本更新暂时无法读取，请稍后重试", response.status, body.error || body.code);
    }
    return response.json() as Promise<T>;
}

export const listReleaseNotes = (offset = 0, signal?: AbortSignal) => request<ReleaseNotesPage<PublicReleaseNote>>(`/api/release-notes?limit=20&offset=${offset}`, { signal });
export const listAdminReleaseNotes = (offset = 0, signal?: AbortSignal) => request<ReleaseNotesPage<AdminReleaseNote>>(`/api/admin/release-notes?limit=50&offset=${offset}`, { signal });
export const saveReleaseNoteDraft = (version: string, input: ReleaseNoteDraftInput) => request<{ note: AdminReleaseNote }>(`/api/admin/release-notes/${encodeURIComponent(version)}/draft`, { method: "PUT", body: JSON.stringify(input) });
export const publishReleaseNote = (version: string, expectedRevision: number) => request<{ note: AdminReleaseNote }>(`/api/admin/release-notes/${encodeURIComponent(version)}/publish`, { method: "POST", body: JSON.stringify({ expectedRevision }) });

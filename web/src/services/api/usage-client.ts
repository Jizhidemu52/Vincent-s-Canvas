import { USAGE_API, type UsageClientEvent, type UsageEnvelope, type UsageEventsResult, type UsageMeResult } from "../../../../shared/usage-analytics";
export class UsageClientError extends Error { constructor(readonly status: number) { super(`Usage request failed (${status})`); } }

async function usageRequest<T>(url: string, signal: AbortSignal, events?: UsageClientEvent[]): Promise<T> {
    const response = await fetch(url, { method: events ? "POST" : "GET", credentials: "include", cache: "no-store", signal,
        ...(events ? { headers: { "content-type": "application/json" }, body: JSON.stringify({ events }) } : {}) });
    if (!response.ok) throw new UsageClientError(response.status);
    const result = await response.json() as UsageEnvelope<T>;
    if (result.code !== 0 || !result.data) throw new Error("Invalid usage response");
    signal.throwIfAborted();
    return result.data;
}
export const postUsageEvents = (events: UsageClientEvent[], signal: AbortSignal) => usageRequest<UsageEventsResult>(USAGE_API.events, signal, events);
export const getMyUsage = (signal: AbortSignal) => usageRequest<UsageMeResult>(USAGE_API.me, signal);

import { afterEach, describe, expect, test } from "bun:test";
import { loadAdminOverview, resolveAdminTab } from "@/pages/admin/admin-overview";
import { loadTeamOverview } from "@/pages/team/team-overview";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

function pendingRequests() {
    const requests: Array<{ url: string; respond: (body: unknown, status?: number) => void }> = [];
    globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
        expect(init?.method || "GET").toBe("GET");
        return new Promise<Response>((resolve) => requests.push({ url: String(input), respond: (body, status = 200) => resolve(Response.json(body, { status })) }));
    }) as typeof fetch;
    return requests;
}

describe("admin and team overview loading", () => {
    test("admin loads independent sections concurrently and preserves successful sections", async () => {
        const requests = pendingRequests();
        const result = loadAdminOverview();
        expect(requests).toHaveLength(4);
        expect(requests.map((request) => request.url)).toContain("/api/admin/history?page=1&pageSize=1");
        requests[0].respond({ users: [{ id: "account" }] });
        requests[1].respond({ departments: [{ id: "department" }] });
        requests[2].respond({ message: "审计暂不可用" }, 503);
        requests[3].respond({ history: [], totalRmbCost: 123.45 });
        expect(await result).toEqual({ accounts: [{ id: "account" }], departments: [{ id: "department" }], auditLogs: undefined, totalCost: 123.45, errors: ["审计：审计暂不可用"] });
    });

    test("department admins cannot select super-admin tabs through URL parameters", () => {
        for (const tab of ["modules", "pricing", "api", "history", "projects", "batch", "audit", "integrations", "models", "providers", "workflows", "not-a-tab"]) expect(resolveAdminTab(tab, false, true)).toBe("accounts");
        expect(resolveAdminTab("groups", false, true)).toBe("groups");
        expect(resolveAdminTab("performance", false, true)).toBe("performance");
        expect(resolveAdminTab("performance", true, false)).toBe("accounts");
        expect(resolveAdminTab("models", true, true)).toBe("api");
    });

    test("ordinary members request only personal group credits, never leader-only data", async () => {
        const requests = pendingRequests();
        const result = loadTeamOverview(false);
        expect(requests.map((request) => request.url)).toEqual(["/api/group-credits"]);
        requests[0].respond({ groupId: "mine" });
        expect(await result).toMatchObject({ myCredits: { groupId: "mine" }, overview: undefined, managedCredits: undefined, errors: [] });
    });

    test("leader requests launch together and one failure leaves other panels usable", async () => {
        const requests = pendingRequests();
        const result = loadTeamOverview(true);
        expect(requests).toHaveLength(6);
        requests[0].respond({ groupId: "group" });
        requests[1].respond({ group: { id: "group" } });
        requests[2].respond({ history: [{ id: "task" }] });
        requests[3].respond({ message: "成果暂不可用" }, 503);
        requests[4].respond({ auditLogs: [] });
        requests[5].respond({ requests: [] });
        expect(await result).toMatchObject({ myCredits: { groupId: "group" }, history: [{ id: "task" }], assets: undefined, auditLogs: [], managedCredits: { requests: [] }, errors: ["最近成果：成果暂不可用"] });
    });
});

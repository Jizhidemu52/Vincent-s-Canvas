import { afterEach, describe, expect, test } from "bun:test";
import { loadAdminOverview, markPlatformAdminTabLabel, resolveAdminTab } from "@/pages/admin/admin-overview";
import { loadTeamOverview, nonFinancialTeamCsv } from "@/pages/team/team-overview";

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
        expect(requests.map((request) => request.url)).toContain("/api/admin/history?limit=1");
        requests[0].respond({ users: [{ id: "account" }], totalUsedCredits: 0 });
        requests[1].respond({ departments: [{ id: "department" }] });
        requests[2].respond({ message: "审计暂不可用" }, 503);
        requests[3].respond({ history: [], totalRmbCost: 123.45 });
        expect(await result).toEqual({ accounts: [{ id: "account" }], totalUsedCredits: 0, departments: [{ id: "department" }], auditLogs: undefined, totalCost: 123.45, errors: ["审计：审计暂不可用"] });
    });

    test("department admins cannot select super-admin tabs through URL parameters", () => {
        for (const tab of ["modules", "pricing", "api", "usage-analysis", "mark-images", "history", "projects", "batch", "audit", "integrations", "models", "providers", "workflows", "not-a-tab"]) expect(resolveAdminTab(tab, false, true)).toBe("accounts");
        expect(resolveAdminTab("groups", false, true)).toBe("groups");
        expect(resolveAdminTab("performance", false, true)).toBe("performance");
        expect(resolveAdminTab("performance", true, false)).toBe("accounts");
        expect(resolveAdminTab("models", true, true)).toBe("api");
        expect(resolveAdminTab("mark-images", true, true)).toBe("mark-images");
        expect(resolveAdminTab("usage-analysis", true, true)).toBe("usage-analysis");
        expect(markPlatformAdminTabLabel).toBe("APIMart 平台");
    });

    test("removed pricing URLs return to accounts while advanced model configuration remains available", () => {
        expect(resolveAdminTab("pricing", true, true)).toBe("accounts");
        expect(resolveAdminTab("pricing", false, true)).toBe("accounts");
        expect(resolveAdminTab("models", true, true)).toBe("api");
        expect(resolveAdminTab("api", true, true)).toBe("api");
    });

    test("ordinary members request neither retired financial endpoints nor leader-only data", async () => {
        const requests = pendingRequests();
        const result = loadTeamOverview(false);
        expect(requests).toEqual([]);
        expect(await result).toMatchObject({ overview: undefined, history: undefined, assets: undefined, auditLogs: undefined, errors: [] });
    });

    test("leader requests launch together and one failure leaves other panels usable", async () => {
        const requests = pendingRequests();
        const result = loadTeamOverview(true);
        expect(requests).toHaveLength(4);
        expect(requests.every(request => !request.url.includes("credits"))).toBe(true);
        requests[0].respond({ group: { id: "group" } });
        requests[1].respond({ history: [{ id: "task" }] });
        requests[2].respond({ message: "成果暂不可用" }, 503);
        requests[3].respond({ auditLogs: [] });
        expect(await result).toMatchObject({ history: [{ id: "task" }], assets: undefined, auditLogs: [], errors: ["最近成果：成果暂不可用"] });
    });

    test("team CSV removes only financial columns and preserves complete quoted prompt cells", () => {
        const header = '时间,设计师,功能板块,模型,完整提示词,积分,人民币成本,状态,失败原因';
        const row = '2026-11-12,小张,image,测试模型,"保留字样 积分,用作图案\r\n还有""引号""",0,0.05368,success,""';
        const csv = `\uFEFF${header}\r\n${row}\r\n`;
        expect(nonFinancialTeamCsv(csv)).toBe('\uFEFF"时间","设计师","功能板块","模型","完整提示词","状态","失败原因"\r\n"2026-11-12","小张","image","测试模型","保留字样 积分,用作图案\r\n还有""引号""","success",""\r\n');
        expect(csv).toContain(",0,0.05368,");
        expect(nonFinancialTeamCsv(header)).toBe('\uFEFF"时间","设计师","功能板块","模型","完整提示词","状态","失败原因"');
        expect(nonFinancialTeamCsv(`${header}\r\n2026,a,image,m,'=SUM(A1),0,0,success,`)).toContain('"\'=SUM(A1)"');
        expect(() => nonFinancialTeamCsv(`${header}\r\n2026,a,b`)).toThrow("报表格式异常");
        expect(() => nonFinancialTeamCsv(`${header}\r\n"unterminated`)).toThrow("报表格式异常");
        expect(() => nonFinancialTeamCsv(header.replace("积分", "新金额列"))).toThrow("报表格式异常");
    });
});

import { describe, expect, test } from "bun:test";
import { frequentUsageDestinations, usageBoardAvailable, usageBoardForLocation, usageDestinations } from "../src/lib/usage-navigation";
import { moduleDefinitions, type ModuleKey } from "../../shared/feature-catalog";
import { navigationModuleKey, navigationToolBilling, navigationTools } from "../src/constant/navigation-tools";
import { retiredWorkbenchName } from "../src/lib/retired-workbenches";
const flags = Object.fromEntries(moduleDefinitions.map(item => [item.moduleKey, true])) as Record<ModuleKey, boolean>;
describe("usage board navigation", () => {
    test("chat navigation uses the same per-model-call estimator as paid AI tools", () => {
        expect(navigationToolBilling["gpt-chat"]).toEqual({ operationType: "chat", toolKey: "gpt-chat" });
        expect(navigationTools.find(item => item.slug === "gpt-chat")).toMatchObject({ path: "/chat", label: "对话改图" });
        expect(frequentUsageDestinations({ "gpt-chat": 3 }, flags, []).map(item => ({ path: item.path, label: item.label }))).toEqual([{ path: "/chat", label: "对话改图" }]);
    });
    test("canonical boards never retain query strings or project IDs", () => {
        expect(usageBoardForLocation("/canvas/private-id", "?token=private")).toBe("canvas");
        expect(usageBoardForLocation("/image", "?tool=midjourney-blend&private=secret")).toBe("midjourney-blend");
        expect(usageBoardForLocation("/creative/garment-colorway")).toBe("creative-garment-colorway");
        expect(usageBoardForLocation("/my-prompts")).toBe("prompts");
        for (const path of ["/admin", "/admin/login", "/team", "/performance", "/change-password", "/login", "/unknown"]) expect(usageBoardForLocation(path)).toBeNull();
    });
    test("personal ordering is descending, deterministic, and excludes disabled modules/parents/bindings", () => {
        const counts = { image: 10, video: 20, "creative-garment-colorway": 15, assets: 9, prompts: 8, canvas: 7, team: 9999 };
        expect(frequentUsageDestinations(counts, flags, []).map(item => item.key)).toEqual(["video", "creative-garment-colorway", "image", "assets", "prompts"]);
        expect(frequentUsageDestinations(counts, { ...flags, creative: false }, [{ toolKey: "video", enabled: false }]).map(item => item.key)).toEqual(["image", "assets", "prompts", "canvas"]);
        expect(usageBoardAvailable("creative-garment-colorway", flags, [{ toolKey: "creative", enabled: false }])).toBe(false);
        expect(usageBoardAvailable("secret", flags, [])).toBe(false);
    });
    test("only the three retired boards disappear while independent entries retain workflow permissions", () => {
        expect(navigationTools.slice(0, 3).map(item => item.slug)).toEqual(["local-restyle", "garment-colorway", "back-design"]);
        for (const id of ["local-restyle", "garment-colorway", "back-design"] as const) {
            expect(navigationModuleKey(id)).toBe(`creative-${id}`);
            expect(usageBoardForLocation(`/${id}`)).toBe(`creative-${id}`);
            expect(usageDestinations.filter(item => item.key === `creative-${id}`)).toHaveLength(1);
            expect(frequentUsageDestinations({ [`creative-${id}`]: 1 }, flags, [])[0].path).toBe(`/${id}`);
        }
        for (const [path, search] of [["/image", "?tool=detail-enhance"], ["/image", "?tool=angle-control"], ["/creative/series-recipe", ""]]) {
            expect(retiredWorkbenchName(path, search)).toBeTruthy();
            expect(usageBoardForLocation(path, search)).toBeNull();
        }
        expect(usageDestinations.some(item => ["detail-enhance", "angle-control", "series-recipe"].includes(item.key))).toBe(false);
        expect(retiredWorkbenchName("/hd-upscale")).toBeUndefined();
        expect(retiredWorkbenchName("/image", "?tool=hd-upscale")).toBeUndefined();
        expect(navigationTools.find(item => item.slug === "hd-upscale")).toMatchObject({ label: "高清放大", path: "/hd-upscale" });
        expect(navigationToolBilling["hd-upscale"]).toEqual({ operationType: "upscale", toolKey: "detail-enhance" });
    });
});

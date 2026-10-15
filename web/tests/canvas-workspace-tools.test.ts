import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { navigationTools } from "../src/constant/navigation-tools";
import { usageDestinations } from "../src/lib/usage-navigation";
import { moduleDefinitions, type ModuleKey } from "../../shared/feature-catalog";
import { canvasWorkspaceTools, filterCanvasWorkspaceTools } from "../src/components/canvas/canvas-workspace-tools-model";

const flags = Object.fromEntries(moduleDefinitions.map(item => [item.moduleKey, true])) as Record<ModuleKey, boolean>;
const access = { flags, bindings: [], rolePortalsEnabled: true, adminVisible: true, teamVisible: true };

describe("canvas workspace tools", () => {
    test("preserves every existing navigation and creative destination without duplicate routes", () => {
        const entries = canvasWorkspaceTools(access);
        for (const item of [...navigationTools, ...usageDestinations]) expect(entries.some(entry => entry.path === item.path)).toBe(true);
        expect(new Set(entries.map(item => item.path)).size).toBe(entries.length);
    });

    test("every formal module remains discoverable through its existing workspace", () => {
        const entries = canvasWorkspaceTools(access);
        const covered = new Set(entries.flatMap(item => [item.moduleKey, ...item.capabilities.map(capability => capability.moduleKey)]));
        expect(moduleDefinitions.filter(item => !covered.has(item.moduleKey))).toEqual([]);
    });

    test("every destination matches an actual router path or a registered creative scene", () => {
        const routes = readFileSync(new URL("../src/router.tsx", import.meta.url), "utf8");
        for (const item of canvasWorkspaceTools(access)) {
            const pathname = item.path.split("?")[0];
            const creativeScene = usageDestinations.some(destination => destination.path === pathname && destination.moduleKey.startsWith("creative-"));
            expect(creativeScene || routes.includes(`path: "${pathname}"`)).toBe(true);
        }
    });

    test("respects deployment role portals and role ownership", () => {
        expect(canvasWorkspaceTools({ ...access, rolePortalsEnabled: false }).some(item => item.group === "管理中心")).toBe(false);
        expect(canvasWorkspaceTools({ ...access, adminVisible: false, teamVisible: false }).some(item => item.group === "管理中心")).toBe(false);
        const team = canvasWorkspaceTools({ ...access, adminVisible: false });
        expect(team.some(item => item.path === "/team")).toBe(true);
        expect(team.some(item => item.path.startsWith("/admin"))).toBe(false);
    });

    test("filters disabled modules, parent modules and business bindings", () => {
        const entries = canvasWorkspaceTools({ ...access, flags: { ...flags, creative: false, prompts: false }, bindings: [{ toolKey: "video", enabled: false }, { toolKey: "canvas", enabled: false }] });
        expect(entries.some(item => item.path.startsWith("/creative"))).toBe(false);
        expect(entries.some(item => item.path.includes("prompts"))).toBe(false);
        expect(entries.some(item => item.moduleKey === "video" || item.moduleKey === "canvas")).toBe(false);
    });

    test("search finds embedded tools in their real hosts and does not expose disabled capabilities", () => {
        const entries = canvasWorkspaceTools(access);
        expect(filterCanvasWorkspaceTools(entries, "SVG").map(item => item.path)).toEqual(["/creative/style-to-sketch"]);
        expect(filterCanvasWorkspaceTools(entries, "照片取色").map(item => item.path)).toEqual(["/creative/garment-colorway"]);
        expect(filterCanvasWorkspaceTools(entries, "花型循环")[0]?.path).toBe("/creative/pattern-repeat");
        const disabled = canvasWorkspaceTools({ ...access, flags: { ...flags, "standard-colors": false, "canvas-audio": false } });
        expect(filterCanvasWorkspaceTools(disabled, "照片取色")).toEqual([]);
        expect(filterCanvasWorkspaceTools(disabled, "音频生成")).toEqual([]);
        expect(filterCanvasWorkspaceTools(entries, "", "AI 工作台").every(item => item.group === "AI 工作台")).toBe(true);
    });
});

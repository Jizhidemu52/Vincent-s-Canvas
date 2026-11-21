import { afterEach, describe, expect, test } from "bun:test";
import { loadDeploymentFeatures, normalizeDeploymentFeatures } from "@/lib/deployment-features";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

const openFeatures = { authenticationEnabled: false, creditsEnabled: false, rolePortalsEnabled: false, oaLoginEnabled: false, imageConversationsEnabled: false,productCardsEnabled:false,tryoutDisplayBeforeSave:false };

describe("deployment switches", () => {
    test("opens creative workspaces without account or credit gates by default", () => {
        expect(normalizeDeploymentFeatures()).toEqual(openFeatures);
    });
    test("password and OA authentication support explicit credit and portal settings", () => {
        expect(normalizeDeploymentFeatures({ oaLoginEnabled: true })).toEqual({ ...openFeatures, authenticationEnabled: true, oaLoginEnabled: true });
        expect(normalizeDeploymentFeatures({ authenticationEnabled: true, creditsEnabled: true, rolePortalsEnabled: true })).toEqual({ ...openFeatures, authenticationEnabled: true, creditsEnabled: true, rolePortalsEnabled: true });
    });
    test("does not show credit quotas for anonymous use", () => {
        expect(normalizeDeploymentFeatures({ authenticationEnabled: false, creditsEnabled: true, rolePortalsEnabled: true })).toMatchObject({ authenticationEnabled: false, creditsEnabled: false, rolePortalsEnabled: false });
    });
    test("server conversations require authentication and an explicit enable flag", () => {
        expect(normalizeDeploymentFeatures({ imageConversationsEnabled: true }).imageConversationsEnabled).toBe(false);
        expect(normalizeDeploymentFeatures({ authenticationEnabled: true, imageConversationsEnabled: true }).imageConversationsEnabled).toBe(true);
        expect(normalizeDeploymentFeatures({ authenticationEnabled: true }).imageConversationsEnabled).toBe(false);
    });
    test("startup still fails closed on missing or invalid deployment responses", async () => {
        for (const response of [new Response("offline", { status: 503 }), Response.json({}), Response.json(null), Response.json({ ...openFeatures, authenticationEnabled: "false" })]) {
            globalThis.fetch = (async () => response) as typeof fetch;
            expect(await loadDeploymentFeatures()).toBe(false);
        }
        globalThis.fetch = (async () => { throw new Error("network error"); }) as typeof fetch;
        expect(await loadDeploymentFeatures()).toBe(false);
    });
    test("accepts the real open deployment contract", async () => {
        expect(normalizeDeploymentFeatures({productCardsEnabled:true}).productCardsEnabled).toBe(false);
        expect(normalizeDeploymentFeatures({authenticationEnabled:true}).productCardsEnabled).toBe(false);
        expect(normalizeDeploymentFeatures({authenticationEnabled:true,productCardsEnabled:true}).productCardsEnabled).toBe(true);
        globalThis.fetch = (async () => Response.json(openFeatures)) as typeof fetch;
        expect(await loadDeploymentFeatures()).toBe(true);
    });
});

import { describe, expect, test } from "bun:test";
import { normalizeDeploymentFeatures } from "@/lib/deployment-features";

describe("deployment switches", () => {
    test("fails closed with missing configuration", () => {
        expect(normalizeDeploymentFeatures()).toEqual({ authenticationEnabled: true, creditsEnabled: true, rolePortalsEnabled: true, oaLoginEnabled: false });
    });
    test("supports login without credits or separate role portals", () => {
        expect(normalizeDeploymentFeatures({ creditsEnabled: false, rolePortalsEnabled: false })).toEqual({ authenticationEnabled: true, creditsEnabled: false, rolePortalsEnabled: false, oaLoginEnabled: false });
    });
    test("does not show credit quotas for anonymous use", () => {
        expect(normalizeDeploymentFeatures({ authenticationEnabled: false })).toMatchObject({ authenticationEnabled: false, creditsEnabled: false });
    });
    test("OA always authenticates and disables role portals", () => {
        expect(normalizeDeploymentFeatures({ oaLoginEnabled: true, authenticationEnabled: false, rolePortalsEnabled: true, creditsEnabled: false }))
            .toEqual({ oaLoginEnabled: true, authenticationEnabled: true, rolePortalsEnabled: false, creditsEnabled: false });
    });
});

import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import ts from "typescript";

import { deploymentFeatures } from "@/lib/deployment-features";
import type { Asset } from "@/stores/use-asset-store";
import { useUserStore, type LocalUser } from "@/stores/use-user-store";

const initialOaMode = deploymentFeatures.oaLoginEnabled;
const initialUser = useUserStore.getState().user;

// Execute the real permission functions without booting browser-only canvas persistence.
const source = readFileSync(new URL("../src/stores/use-asset-store.ts", import.meta.url), "utf8");
const ast = ts.createSourceFile("asset-store.ts", source, ts.ScriptTarget.Latest, true);
const names = new Set(["assetOwnerId", "canUserAccessAsset", "canCurrentUserManageAsset", "currentAssetOwnerId"]);
const code = ts.transpileModule(ast.statements.filter(statement => ts.isFunctionDeclaration(statement) && names.has(statement.name?.text || "")).map(statement => statement.getText(ast)).join("\n"), {
    compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.CommonJS },
}).outputText;
const permissions = {} as {
    assetOwnerId: (asset: Pick<Asset, "ownerId" | "metadata">) => string;
    canUserAccessAsset: (asset: Asset, user: LocalUser | null, serverAuthorized?: boolean) => boolean;
};
new Function("deploymentFeatures", "useUserStore", "exports", code)(deploymentFeatures, useUserStore, permissions);
const { assetOwnerId, canUserAccessAsset } = permissions;

const employee: LocalUser = {
    id: "employee-b", username: "b", displayName: "B", avatarUrl: "", email: null, employeeNo: null,
    role: "designer", status: "active", departmentId: "department-1", departmentName: null,
    groupId: null, groupName: null, groupRole: null, mustChangePassword: false, mfaEnabled: false,
    creditBalance: 0, creditLimit: 0, monthlyCreditLimit: 0, temporaryCreditAdjustment: 0,
    creditPeriodStart: "", creditResetAt: "",
};
const cachedAsset: Asset = {
    id: "local-asset-a", ownerId: "employee-a", kind: "image", title: "A private image",
    coverUrl: "blob:previous-employee", tags: [], createdAt: "", updatedAt: "",
    data: { dataUrl: "blob:previous-employee", storageKey: "image:a", width: 100, height: 100, bytes: 10, mimeType: "image/png" },
    metadata: { serverAssetId: "server-asset-a", companyDatabaseStatus: "synced", designerId: "employee-a", departmentId: "department-1" },
};

afterEach(() => {
    deploymentFeatures.oaLoginEnabled = initialOaMode;
    useUserStore.setState({ user: initialUser });
});

describe("employee asset isolation", () => {
    test("a saved server asset id is not permission to read another employee's local blob", () => {
        for (const oaMode of [false, true]) {
            deploymentFeatures.oaLoginEnabled = oaMode;
            expect(canUserAccessAsset(cachedAsset, employee)).toBe(false);
            expect(canUserAccessAsset(cachedAsset, { ...employee, id: "employee-a" })).toBe(true);
            expect(canUserAccessAsset(cachedAsset, null)).toBe(false);
        }
    });

    test("an ownerless persisted asset is never assigned to whoever signs in next", () => {
        useUserStore.setState({ user: employee });
        const ownerless = { ...cachedAsset, ownerId: "", metadata: {} };
        expect(assetOwnerId(ownerless)).toBe("unassigned");
        expect(canUserAccessAsset(ownerless, employee)).toBe(false);
        expect(assetOwnerId({ ...ownerless, metadata: { designerId: "employee-a" } })).toBe("employee-a");
    });

    test("OA users cannot use administrator roles to read another employee's local data", () => {
        deploymentFeatures.oaLoginEnabled = true;
        expect(canUserAccessAsset(cachedAsset, { ...employee, role: "super_admin" })).toBe(false);
        expect(canUserAccessAsset(cachedAsset, { ...employee, role: "department_admin" })).toBe(false);
    });

    test("non-OA administrator and department permissions remain available", () => {
        deploymentFeatures.oaLoginEnabled = false;
        expect(canUserAccessAsset(cachedAsset, { ...employee, role: "super_admin" })).toBe(true);
        expect(canUserAccessAsset(cachedAsset, { ...employee, role: "department_admin" })).toBe(true);
        expect(canUserAccessAsset(cachedAsset, { ...employee, role: "department_admin", departmentId: "department-2" })).toBe(false);
    });

    test("only a current server-authorized response can grant non-OA sharing access", () => {
        const shared = { ...cachedAsset, metadata: {} };
        deploymentFeatures.oaLoginEnabled = false;
        expect(canUserAccessAsset(shared, employee, true)).toBe(true);
        expect(canUserAccessAsset(shared, employee)).toBe(false);
        deploymentFeatures.oaLoginEnabled = true;
        expect(canUserAccessAsset(shared, employee, true)).toBe(false);
    });
});

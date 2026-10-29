import { i18nHarness } from "./helpers/i18n-harness";
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import React, { type ReactElement } from "react";
import Papa from "papaparse";
import ts from "typescript";

const person = {
    id: "person", username: "existing", displayName: "现有成员", email: null, employeeNo: "ExistingMember",
    role: "designer", status: "active", departmentId: null, departmentName: null,
    groupId: null, groupName: null, groupRole: null, mustChangePassword: false, mfaEnabled: false,
    creditBalance: 500, creditLimit: 500, monthlyCreditLimit: 500, temporaryCreditAdjustment: 0,
    creditPeriodStart: "2026-10-01", creditResetAt: "2026-11-01",
};
const department = { id: "department-1", code: "design", name: "设计部", createdAt: "2026-10-01" };
const formValues = { loginName: "new-person", name: "新成员", employeeNo: " NewMember ", role: "designer", status: "active", quotaRemaining: 500, monthlyCreditLimit: 500 };

function elements(node: unknown): ReactElement<any>[] {
    if (Array.isArray(node)) return node.flatMap(elements);
    if (!React.isValidElement(node)) return [];
    const item = node as ReactElement<any>;
    return [item, ...elements(item.props.children), ...elements(item.props.items?.map((entry: any) => entry.children))];
}

function page(wecom: boolean | Error = true) {
    const url = new URL("../src/pages/admin/index.tsx", import.meta.url);
    const requireModule = createRequire(url);
    const compile = (source: URL) => ts.transpileModule(readFileSync(source, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true } }).outputText;
    const requests: Array<{ path: string; method: string; body: any }> = [];
    const api = { exports: {} as any };
    new Function("require", "module", "exports", "fetch", compile(new URL("../src/services/api/admin-accounts.ts", import.meta.url)))(
        requireModule, api, api.exports,
        async (path: string, init: RequestInit = {}) => {
            requests.push({ path, method: init.method || "GET", body: init.body ? JSON.parse(String(init.body)) : null });
            return Response.json(path.endsWith("/bulk") ? { created: requests.at(-1)!.body.accounts.length, failures: [] } : { user: person });
        },
    );
    const state: any[] = [], effects: any[] = [], queue: Array<() => void> = [], forms: any[] = [], notices: string[] = [], downloads: Blob[] = [];
    let cursor = 0;
    const Form = Object.assign(function Form() {}, {
        Item: "FormItem",
        useForm() {
            const index = cursor++;
            if (!state[index]) {
                state[index] = { fields: {}, getFieldValue(key: string) { return this.fields[key]; }, setFieldValue(key: string, value: unknown) { this.fields[key] = value; }, setFieldsValue(values: any) { Object.assign(this.fields, values); }, resetFields() { this.fields = {}; } };
                forms.push(state[index]);
            }
            return [state[index]];
        },
        useWatch: (key: string, form: any) => form.fields[key],
    });
    const dependencies: Record<string, any> = {
        "@/lib/i18n": i18nHarness,
        react: { ...React, lazy: () => "LazyPanel",
            useState(initial: any) { const index = cursor++; if (!(index in state)) state[index] = typeof initial === "function" ? initial() : initial; return [state[index], (next: any) => { state[index] = typeof next === "function" ? next(state[index]) : next; }]; },
            useRef(initial: any) { const index = cursor++; return state[index] ||= { current: initial }; },
            useEffect(effect: any, deps: any[]) { const index = cursor++; if (!effects[index] || deps.some((value, item) => !Object.is(value, effects[index].deps[item]))) queue.push(() => { effects[index]?.cleanup?.(); effects[index] = { deps, cleanup: effect() }; }); },
        },
        antd: new Proxy({ Form, App: { useApp: () => ({ message: { success: (text: string) => notices.push(text), warning: (text: string) => notices.push(text), error: (text: string) => notices.push(text) } }) }, Input: { Password: "Password" }, Typography: { Paragraph: "Paragraph" } }, { get: (target, key) => key in target ? target[key as keyof typeof target] : String(key) }),
        "lucide-react": new Proxy({}, { get: (_, key) => String(key) }),
        "file-saver": { saveAs: (blob: Blob) => downloads.push(blob) }, papaparse: Papa,
        "react-router-dom": { Link: "Link", Navigate: "Navigate", useNavigate: () => () => {}, useSearchParams: () => [new URLSearchParams(), () => {}] },
        "@/stores/use-user-store": { isAdminRole: () => true, useUserStore: (select: Function) => select({ user: { ...person, id: "operator", role: "super_admin" }, hydrateSession: async () => {} }) },
        "@/stores/use-module-store": { useModuleStore: (select: Function) => select({ flags: { performance: false } }) },
        "@/lib/deployment-features": { deploymentFeatures: { oaLoginEnabled: false } },
        "./admin-overview": { loadAdminOverview: async () => ({ accounts: [person], departments: [department], auditLogs: [], errors: [] }), resolveAdminTab: () => "accounts" },
        "@/services/api/admin-accounts": api.exports,
        "@/services/api/auth": { getAuthMethods: async () => { if (wecom instanceof Error) throw wecom; return { password: true, wecom, wecomLoginUrl: wecom ? "https://example.test/login?scan=1" : null }; } },
    };
    const module = { exports: {} as any };
    new Function("require", "module", "exports", compile(url))((name: string) => Object.hasOwn(dependencies, name) ? dependencies[name] : requireModule(name), module, module.exports);
    const render = () => { cursor = 0; const tree = elements(module.exports.default()); for (const effect of queue.splice(0)) effect(); return tree; };
    return {
        requests, notices, forms, downloads, render,
        async settle() { let tree = render(); for (let index = 0; index < 18; index++) { await Promise.resolve(); tree = render(); } return tree; },
        async submit(values: any) { return render().find(item => item.props.name === "admin-account")!.props.onFinish(values); },
        async import(csv: string) { return render().find(item => item.type === "Upload")!.props.beforeUpload(new File([csv], "accounts.csv", { type: "text/csv" })); },
        dispose() { effects.forEach(effect => effect.cleanup?.()); },
    };
}

test("configured WeCom designer creation hides password, requires member identity and sends no residual password", async () => {
    const panel = page();
    try {
        const tree = await panel.settle();
        expect(tree.some(item => item.props.name === "password")).toBe(false);
        expect(tree.find(item => item.props.name === "employeeNo")!.props.rules).toContainEqual(expect.objectContaining({ required: true }));
        await panel.submit({ ...formValues, password: "StalePassword123!" });
        expect(panel.requests).toHaveLength(1);
        expect(panel.requests[0]).toEqual({ path: "/api/admin/accounts", method: "POST", body: { username: "new-person", displayName: "新成员", email: null, employeeNo: "NewMember", departmentId: null, role: "designer", status: "active", creditBalance: 500, creditLimit: 500, monthlyCreditLimit: 500 } });
        expect(panel.notices.at(-1)).toContain("企业微信");
        expect(panel.notices.at(-1)).not.toContain("修改密码");
        await panel.submit({ ...formValues, employeeNo: " " });
        expect(panel.requests).toHaveLength(1);
        expect(panel.notices.at(-1)).toContain("企业微信成员账号");
    } finally { panel.dispose(); }
});

test("password deployment and unconfirmed discovery never enable passwordless account creation", async () => {
    for (const methods of [false, new Error("offline")]) {
        const panel = page(methods);
        try {
            const tree = await panel.settle();
            expect(tree.some(item => item.props.name === "password")).toBe(true);
            await panel.submit({ ...formValues, password: "" });
            await panel.submit({ ...formValues, password: "short1" });
            expect(panel.requests).toHaveLength(0);
            await panel.submit({ ...formValues, password: "StrongPassword123" });
            expect(panel.requests[0].body.password).toBe("StrongPassword123");
        } finally { panel.dispose(); }
    }
});

test("department administrator creation retains password and department requirements under WeCom", async () => {
    const panel = page();
    try {
        await panel.settle();
        panel.forms[2].setFieldsValue({ role: "department_admin" });
        expect(panel.render().some(item => item.props.name === "password")).toBe(true);
        await panel.submit({ ...formValues, role: "department_admin", password: "StrongPassword123" });
        expect(panel.requests).toHaveLength(0);
        await panel.submit({ ...formValues, role: "department_admin", departmentId: department.id, password: "StrongPassword123" });
        expect(panel.requests[0].body).toMatchObject({ role: "department_admin", departmentId: department.id, password: "StrongPassword123" });
    } finally { panel.dispose(); }
});

test("editing an existing account retains optional password reset behavior", async () => {
    const panel = page();
    try {
        const tree = await panel.settle();
        const table = tree.find(item => item.type === "Table" && item.props.dataSource[0]?.id === person.id)!;
        table.props.columns.find((column: any) => column.title === "操作").render(null, person).props.onClick();
        expect(panel.render().find(item => item.props.name === "password")!.props.rules).toEqual([]);
        await panel.submit({ ...panel.forms[2].fields, password: "ChangedPassword123" });
        expect(panel.requests.map(item => item.path)).toEqual(["/api/admin/accounts/person", "/api/admin/accounts/person/reset-password"]);
        expect(panel.requests[1].body).toEqual({ password: "ChangedPassword123" });
    } finally { panel.dispose(); }
});

test("WeCom CSV and template omit password, allow no department, and preserve unknown-department and member checks", async () => {
    const panel = page();
    try {
        const tree = await panel.settle();
        tree.find(item => item.props.children === "下载模板")!.props.onClick();
        const template = Papa.parse<Record<string, string>>(await panel.downloads[0].text(), { header: true });
        expect(template.meta.fields).not.toContain("password");
        expect(template.meta.fields).toContain("employeeNo");
        const csv = "username,displayName,employeeNo,departmentCode,creditBalance,creditLimit\nnew-person,新成员,NewMember,,0,500";
        await panel.import(csv);
        expect(panel.requests[0]).toEqual({ path: "/api/admin/accounts/bulk", method: "POST", body: { accounts: [{ username: "new-person", displayName: "新成员", email: null, employeeNo: "NewMember", role: "designer", departmentId: null, creditBalance: 0, creditLimit: 500 }] } });
        await panel.import("username,displayName,employeeNo,password\nsecond,第二位,Member2,");
        expect(panel.requests[1].body.accounts[0]).not.toHaveProperty("password");
        await panel.import(csv.replace("NewMember,,", "NewMember,missing,"));
        expect(panel.notices.at(-1)).toContain("部门编码不存在");
        await panel.import(csv.replace("NewMember", " "));
        expect(panel.notices.at(-1)).toContain("企业微信成员账号");
        await panel.import("username,displayName,role,password\nmanager,管理员,department_admin,StrongPassword123");
        expect(panel.notices.at(-1)).toContain("部门");
        expect(panel.requests).toHaveLength(2);
    } finally { panel.dispose(); }
});

test("CSV batch stays capped at 200 and password-only deployments reject empty passwords", async () => {
    const panel = page(false);
    try {
        const tree = await panel.settle();
        tree.find(item => item.props.children === "下载模板")!.props.onClick();
        expect(Papa.parse(await panel.downloads[0].text(), { header: true }).meta.fields).toContain("password");
        await panel.import("username,displayName,departmentCode\nnew-person,新成员,design");
        expect(panel.requests).toHaveLength(0);
        const rows = Array.from({ length: 201 }, (_, index) => `person${index},成员${index},StrongPassword123`);
        await panel.import(`username,displayName,password\n${rows.join("\n")}`);
        expect(panel.requests).toHaveLength(0);
        expect(panel.notices.at(-1)).toContain("200");
        await panel.import(`username,displayName,password\n${rows.slice(0, 200).join("\n")}`);
        expect(panel.requests[0].body.accounts).toHaveLength(200);
    } finally { panel.dispose(); }
});

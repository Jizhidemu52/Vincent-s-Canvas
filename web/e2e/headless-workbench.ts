import type { Page } from "@playwright/test";

export const workbenchPanes = (page: Page) => page.getByRole("region", { name: /^(创作工作区|Creation workspace)$/, exact: true }).locator(":scope > div:last-child > div");
export const activeWorkbench = (page: Page) => workbenchPanes(page).filter({ visible: true });

export async function showMobilePane(page: Page, label: "创作" | "查看结果") {
    const tabs = page.getByRole("navigation", { name: "工作区视图", exact: true });
    if ((page.viewportSize()?.width ?? 1024) < 768) await tabs.getByRole("button", { name: label, exact: true }).click();
}

export async function expandMobileOptions(page: Page, label: string) {
    const toggle = page.getByRole("button", { name: label, exact: true }).filter({ visible: true });
    if ((page.viewportSize()?.width ?? 1024) < 768 && await toggle.getAttribute("aria-expanded") === "false") await toggle.click();
}

export type WorkbenchRegistryRecord = {
    key: string;
    value: { version: 1; activeId: string; nextNumber: number; tasks: Array<{ id: string; number: number; createdAt: number }> };
};

export async function readWorkspaceRecords<T = unknown>(page: Page, store: string): Promise<Array<{ key: string; value: T }>> {
    return page.evaluate(async name => {
        const { createWorkspaceStorage } = await import("/src/lib/workspace-storage.ts");
        const records: Array<{ key: string; value: unknown }> = [];
        await createWorkspaceStorage(name).iterate((value, key) => { records.push({ key, value }); });
        return records;
    }, store) as Promise<Array<{ key: string; value: T }>>;
}

export const readWorkbenchRegistry = (page: Page) => readWorkspaceRecords<WorkbenchRegistryRecord["value"]>(page, "generation_workbench_tasks");

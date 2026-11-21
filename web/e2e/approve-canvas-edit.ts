import { expect, type Page } from "@playwright/test";
import type { MockCanvasApi } from "./fixtures";

export async function approveEdit(page: Page, api: MockCanvasApi, previousSubmissions: number) {
    const approval = page.locator(".cw-agent-panel").getByRole("button", { name: "批准执行", exact: true });
    await expect(approval).toBeVisible();
    expect(api.submissions).toHaveLength(previousSubmissions);
    await approval.click();
}

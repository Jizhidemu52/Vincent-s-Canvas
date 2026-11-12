import { expect, type Locator } from "@playwright/test";

/** Ant Design renders its visible options in a portal; the ARIA option mirror is virtual and hidden. */
export async function chooseAntSelect(control: Locator, label: string) {
    await control.click();
    await control.page().locator(`.ant-select-dropdown:visible .ant-select-item-option[title=${JSON.stringify(label)}]`).click();
    await expect(antSelect(control)).toHaveText(label);
}

/** Assert the visible selected value, not the combobox's empty search input. */
export function antSelect(control: Locator) {
    return control.locator("xpath=ancestor::*[contains(concat(' ', normalize-space(@class), ' '), ' ant-select ')][1]");
}

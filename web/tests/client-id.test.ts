import { expect, test } from "bun:test";

import { createClientId } from "../src/lib/client-id";

test("uses the browser UUID API when it is available", () => {
    expect(createClientId({ randomUUID: () => "browser-uuid" })).toBe("browser-uuid");
});

test("creates a usable unique identifier when crypto has no randomUUID method", () => {
    const first = createClientId({});
    const second = createClientId({});

    expect(first).toMatch(/^client-/);
    expect(second).toMatch(/^client-/);
    expect(first).not.toBe(second);
});

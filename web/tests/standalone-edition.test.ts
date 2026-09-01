import { expect, test } from "bun:test";

import { isStandaloneEdition } from "../src/lib/standalone-edition";

test("only enables the desktop no-login edition for the explicit build flag", () => {
    expect(isStandaloneEdition("true")).toBe(true);
    expect(isStandaloneEdition("false")).toBe(false);
    expect(isStandaloneEdition(undefined)).toBe(false);
});

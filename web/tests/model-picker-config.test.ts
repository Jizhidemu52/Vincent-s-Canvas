import { expect, test } from "bun:test";

import { shouldRefreshModelPickerConfig } from "@/components/model-picker";

test("server model pickers can request idle or failed configuration, but not loading or ready state", () => {
    expect(shouldRefreshModelPickerConfig("image", "idle")).toBe(true);
    expect(shouldRefreshModelPickerConfig("image", "loading")).toBe(false);
    expect(shouldRefreshModelPickerConfig("video", "ready")).toBe(false);
    expect(shouldRefreshModelPickerConfig("text", "error")).toBe(true);
    expect(shouldRefreshModelPickerConfig(undefined, "idle")).toBe(false);
});

test("only server-backed pickers refresh business configuration, including standalone server pickers", () => {
    expect(shouldRefreshModelPickerConfig("image", "idle", "local")).toBe(false);
    expect(shouldRefreshModelPickerConfig("image", "error", "local")).toBe(false);
    expect(shouldRefreshModelPickerConfig("audio", "idle", "server")).toBe(true);
});

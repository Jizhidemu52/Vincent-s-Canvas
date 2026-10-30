import { expect, test } from "bun:test";
import { videoModelSummaryLabel } from "../src/pages/video";
import { defaultConfig } from "../src/stores/use-config-store";

const selected = "d5000000-0000-4000-8000-000000000005";
const models = [{ id: selected, modelId: "happyhorse-1.1", name: "aplmart-happyhorse1.1" }];

test("video summary uses the loaded display name for a dynamic configuration UUID", () => {
    expect(videoModelSummaryLabel(defaultConfig, selected, models)).toBe("aplmart-happyhorse1.1");
    expect(videoModelSummaryLabel(defaultConfig, "happyhorse-1.1", models)).toBe("aplmart-happyhorse1.1");
    expect(videoModelSummaryLabel(defaultConfig, "channel::happyhorse-1.1", models)).toBe("aplmart-happyhorse1.1");
});

test("loading or unknown video selections remain visible without selecting another model", () => {
    const config = { ...defaultConfig, model: "unknown-video", videoModel: "unknown-video" };
    expect(videoModelSummaryLabel(config, selected, [])).toBe(selected);
    expect(videoModelSummaryLabel(config, "unknown-video", models)).toBe("unknown-video");
    expect(videoModelSummaryLabel(config, "channel::unknown-video", models)).toBe("unknown-video");
    expect(config.model).toBe("unknown-video");
    expect(config.videoModel).toBe("unknown-video");
});

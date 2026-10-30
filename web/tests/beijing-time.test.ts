import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { formatBeijingDateTime, formatBeijingTime } from "../src/lib/beijing-time";

describe("generation and billing timestamps use Beijing time", () => {
    test("converts UTC across the date boundary without changing the source instant", () => {
        const instant = new Date("2026-10-29T17:02:03.456Z");
        expect(formatBeijingDateTime(instant)).toBe("2026-10-30 01:02:03");
        expect(instant.toISOString()).toBe("2026-10-29T17:02:03.456Z");
        expect(formatBeijingTime(instant.getTime())).toBe("01:02:03");
    });

    test("Z and +08:00 representations of one instant have identical output", () => {
        expect(formatBeijingDateTime("2026-10-29T16:00:00Z")).toBe("2026-10-30 00:00:00");
        expect(formatBeijingDateTime("2026-10-30T00:00:00+08:00")).toBe("2026-10-30 00:00:00");
    });

    test.each([null, undefined, "", "not-a-date", "2026-10-30T08:00:00", "2026-10-30 08:00:00", Number.NaN, Number.POSITIVE_INFINITY])("ambiguous or invalid timestamps show a placeholder: %s", value => {
        expect(formatBeijingDateTime(value)).toBe("—");
        expect(formatBeijingTime(value)).toBe("—");
    });

    test.each(["UTC", "America/Los_Angeles"])("does not use the browser/runtime timezone: %s", timeZone => {
        const moduleUrl = new URL("../src/lib/beijing-time.ts", import.meta.url).href;
        const code = `import { formatBeijingDateTime } from ${JSON.stringify(moduleUrl)}; process.stdout.write(formatBeijingDateTime("2026-10-29T17:02:03Z"));`;
        const result = spawnSync(process.execPath, ["--eval", code], { encoding: "utf8", env: { ...process.env, TZ: timeZone } });
        expect(result.status).toBe(0);
        expect(result.stdout).toBe("2026-10-30 01:02:03");
    });
});

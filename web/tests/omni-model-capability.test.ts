import { expect, test } from "bun:test";
import { modelMatchesCapability } from "../src/stores/use-config-store";

test("Gemini Omni exact ID is a video model, never a chat or image model", () => {
    for (const model of ["gemini-omni-1.2-flash", "default::gemini-omni-1.2-flash"]) {
        expect(modelMatchesCapability(model, "video")).toBe(true);
        expect(modelMatchesCapability(model, "text")).toBe(false);
        expect(modelMatchesCapability(model, "image")).toBe(false);
    }
    expect(modelMatchesCapability("doubao-seedance-2.5", "video")).toBe(true);
    expect(modelMatchesCapability("gemini-4-carbon", "text")).toBe(true);
});

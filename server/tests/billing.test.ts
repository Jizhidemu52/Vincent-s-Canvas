import { describe, expect, test } from "bun:test";
import { calculatePrice } from "../src/billing";

describe("billing price snapshots", () => {
    test("combines operation and model prices for every output", () => {
        expect(calculatePrice({ operationType: "image_generation", operationCredits: 8, operationRmb: 0.8, modelId: "model-1", modelCredits: 4, modelRmb: 0.35, quantity: 3, priceVersion: 2 })).toEqual({
            operationType: "image_generation", operationCredits: 8, operationRmb: 0.8, modelId: "model-1", modelCredits: 4, modelRmb: 0.35, quantity: 3, priceVersion: 2, totalCredits: 36, totalRmb: 3.45,
        });
    });
});

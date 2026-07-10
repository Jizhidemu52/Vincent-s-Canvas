import { describe, expect, test } from "bun:test";

import { availableBatchActions, availableTaskActions } from "../src/services/api/task-history";

describe("task control availability", () => {
    test("only exposes valid per-image transitions", () => {
        expect(availableTaskActions("waiting")).toEqual(["pause", "cancel"]);
        expect(availableTaskActions("paused")).toEqual(["resume", "cancel"]);
        expect(availableTaskActions("processing")).toEqual([]);
        expect(availableTaskActions("success")).toEqual([]);
    });

    test("uses live batch counters instead of the summary label", () => {
        expect(availableBatchActions({ waitingItems: 3, pausedItems: 0 })).toEqual(["pause", "cancel"]);
        expect(availableBatchActions({ waitingItems: 0, pausedItems: 2 })).toEqual(["resume", "cancel"]);
        expect(availableBatchActions({ waitingItems: 2, pausedItems: 1 })).toEqual(["pause", "resume", "cancel"]);
        expect(availableBatchActions({ waitingItems: 0, pausedItems: 0 })).toEqual([]);
    });
});

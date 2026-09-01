import { expect, test } from "bun:test";

import { DEMO_STREAM_IDLE_TIMEOUT_SECONDS } from "../src/demo-server-config";

test("keeps local Claude streaming requests open beyond Bun's default idle timeout", () => {
  expect(DEMO_STREAM_IDLE_TIMEOUT_SECONDS).toBeGreaterThan(10);
  expect(DEMO_STREAM_IDLE_TIMEOUT_SECONDS).toBe(180);
});

import { describe, expect, test } from "bun:test";

import {
  internalAiRequestTemplate,
  splitInternalAiUrl,
} from "../src/routes/internal-ai-configuration";

describe("internal AI configuration", () => {
  test("splits a full endpoint into encrypted provider and workflow fields", () => {
    expect(
      splitInternalAiUrl(
        "http://122.247.78.91:8101/std/comfy_generate?tenant=design",
      ),
    ).toEqual({
      baseUrl: "http://122.247.78.91:8101",
      submitPath: "/std/comfy_generate?tenant=design",
    });
  });

  test("maps the company app-key JSON protocol to server-side workflow variables", () => {
    expect(internalAiRequestTemplate()).toEqual({
      model_code: "sflxjj",
      task_id: "$taskId",
      app_key: "$appKey",
      input_image: "$sourceBase64",
      cut_width: "$cutWidth",
      redraw_width: "$redrawWidth",
      blur_amount: "$blurAmount",
      redraw_strength: "$redrawStrength",
      steps: "$steps",
    });
  });
});

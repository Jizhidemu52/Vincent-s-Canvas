import { describe, expect, test } from "bun:test";

import {
  internalAiRequestTemplate,
  splitInternalAiUrl,
} from "../src/routes/internal-ai-configuration";

describe("internal AI configuration", () => {
  test("splits a full endpoint into encrypted provider and workflow fields", () => {
    expect(
      splitInternalAiUrl(
        "http://122.247.78.91:8101/std/tohwkdpj?tenant=design",
      ),
    ).toEqual({
      baseUrl: "http://122.247.78.91:8101",
      submitPath: "/std/tohwkdpj?tenant=design",
    });
  });

  test("maps the company app-key JSON protocol to server-side workflow variables", () => {
    expect(internalAiRequestTemplate()).toEqual({
      app_key: "$appKey",
      image: "$sourceBase64",
      rows: "$rows",
      cols: "$cols",
    });
  });
});

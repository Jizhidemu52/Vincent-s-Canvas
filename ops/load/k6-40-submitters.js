import http from "k6/http";
import { check, sleep } from "k6";

export const options = {
  scenarios: {
    designers: { executor: "constant-vus", vus: 40, duration: "2m" },
  },
  thresholds: {
    http_req_failed: ["rate<0.01"],
    http_req_duration: ["p(95)<1500"],
  },
};

const baseUrl = __ENV.BASE_URL;
const sessions = JSON.parse(__ENV.SESSION_COOKIES || "[]");
const modelId = __ENV.MODEL_CONFIG_ID;

if (!baseUrl || !modelId || sessions.length === 0) {
  throw new Error("BASE_URL, MODEL_CONFIG_ID and at least one SESSION_COOKIES entry are required");
}

export default function () {
  const cookie = sessions[(__VU - 1) % sessions.length];
  const payload = JSON.stringify({
    requestId: `load-${__VU}-${__ITER}`,
    projectId: "load-test",
    operationType: "image_generation",
    modelConfigId: modelId,
    prompt: "load test image",
    sourceUrls: [],
    priority: "normal",
  });
  const response = http.post(`${baseUrl}/api/tasks`, payload, {
    headers: { "content-type": "application/json", Cookie: cookie },
  });
  check(response, { "task accepted or quota rejected cleanly": (r) => r.status === 201 || r.status === 400 });
  sleep(1);
}

import { Router } from "express";

import type { AppConfig } from "../config";
import { requireRole } from "../rbac";
import { getWeComStatus } from "../wecom";

export function createIntegrationsRouter(config: AppConfig) {
    const router = Router();
    router.use(requireRole("super_admin"));
    router.get("/status", (_request, response) => {
        response.json({
            wecom: getWeComStatus(config),
            objectStorage: { configured: Boolean(config.S3_ENDPOINT && config.S3_ACCESS_KEY_ID && config.S3_SECRET_ACCESS_KEY), endpoint: config.S3_ENDPOINT || null, bucket: config.S3_BUCKET },
            providerEncryption: { configured: Boolean(config.PROVIDER_ENCRYPTION_KEY) },
            taskRuntime: { mockMode: config.TASK_MOCK_MODE === "true", workerConcurrency: config.WORKER_CONCURRENCY },
            ldap: { configured: false, status: "reserved" },
            oidc: { configured: false, status: "reserved" },
        });
    });
    return router;
}

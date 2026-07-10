import { validateProductionEnvironment } from "../../server/src/production-readiness";

const checks = validateProductionEnvironment(process.env, {
    requireWeCom: Bun.argv.includes("--require-wecom"),
    allowMockMode: Bun.argv.includes("--allow-mock"),
});

const labels = { pass: "通过", warning: "提醒", error: "错误" } as const;
for (const check of checks) console.log(`[${labels[check.level]}] ${check.message}`);
const errors = checks.filter((check) => check.level === "error");
console.log(`\n生产预检：${checks.filter((check) => check.level === "pass").length} 项通过，${checks.filter((check) => check.level === "warning").length} 项提醒，${errors.length} 项错误。`);
if (errors.length) process.exit(1);

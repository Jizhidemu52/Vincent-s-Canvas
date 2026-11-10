/** Offline test helper. Never imports the application client and cannot call a model. */
import { EvalLedger, codeOf } from "./ledger";
const [path, prefix, countText, same] = process.argv.slice(2);
if (!path || !prefix) throw new Error("TEST_ARGUMENTS_REQUIRED");
const ledger = new EvalLedger(path, { single: 100, sequence: 0, reserve: 0 });
let created = 0, exhausted = 0;
for (let index = 0; index < Number(countText); index++) {
  try {
    const result = ledger.reserve(same ? "shared-attempt" : `${prefix}-${index}`, "single", { fixture: "offline", index: same ? 0 : index });
    if (result.created) created++;
    if (same === "crash") process.exit(19);
  } catch (error) {
    if (codeOf(error) === "IMAGE_BUDGET_EXHAUSTED" || codeOf(error) === "GROUP_BUDGET_EXHAUSTED") exhausted++;
    else throw error;
  }
}
ledger.close();
console.log(JSON.stringify({ created, exhausted }));

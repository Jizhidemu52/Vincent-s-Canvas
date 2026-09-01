import { demoAccounts } from "./demo-accounts";

export function resolveStandaloneDemoUser(enabled: boolean) {
  if (!enabled) return null;
  return demoAccounts.find((account) => account.identifier === "designer01")?.user || null;
}

export function billedDemoCredits(standalone: boolean, credits: number) {
  return standalone ? 0 : credits;
}

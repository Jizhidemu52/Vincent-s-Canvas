import { readProviderSubmissionDiagnostics } from "./provider-submission-transport";

/** A provider explicitly rejected this submission before creating paid work. */
export class ProviderSubmissionRejected extends Error {}

export function isDefinitiveSubmissionRejection(status: number) {
  // Timeouts/conflicts and 5xx can occur after acceptance. Never infer failure from those.
  return [400, 401, 403, 404, 405, 413, 415, 422, 429].includes(status);
}

export function submissionWasNotSent(error: unknown) {
  const phase = readProviderSubmissionDiagnostics(error)?.phase;
  return phase === "initial_tls" || phase === "preflight";
}

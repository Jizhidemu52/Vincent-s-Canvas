import type { TurnState } from "./image-conversation-contracts";

export const activeTurnStates: TurnState[] = ["accepted", "planning", "queued", "generating", "uncertain"];

export function turnResultUnconfirmed(state: TurnState, outputVersionId: string | null) {
  return activeTurnStates.includes(state) || (state === "detached" && !outputVersionId);
}

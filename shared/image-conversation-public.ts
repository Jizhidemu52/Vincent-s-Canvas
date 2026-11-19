import type * as Contract from "./image-conversation-contracts";

export type PublicEffectiveImageParameters = Omit<Contract.EffectiveImageParameters, "model"> & { model: Contract.UUID };
export type PublicSettingsSnapshot = Omit<Contract.SettingsSnapshot, "effective" | "policyVersion"> & {
  effective: PublicEffectiveImageParameters;
  policyVersion: "image-auto-v1";
};
export type PublicImageVersion = Omit<Contract.ImageVersion, "parameters"> & { parameters: PublicSettingsSnapshot | null };
export type PublicImageTurn = Omit<Contract.ImageTurn, "settingsSnapshot"> & { settingsSnapshot: PublicSettingsSnapshot | null };
export type PublicConversationSnapshot = Omit<Contract.ConversationSnapshot, "activeVersion" | "pendingTurn"> & {
  activeVersion: PublicImageVersion | null;
  pendingTurn: PublicImageTurn | null;
};
export type PublicImageConversationData<T> = T extends Contract.SettingsSnapshot ? PublicSettingsSnapshot
  : T extends readonly unknown[] ? { [K in keyof T]: PublicImageConversationData<T[K]> }
    : T extends object ? { [K in keyof T]: PublicImageConversationData<T[K]> } : T;
export type PublicConversationEvent = PublicImageConversationData<Contract.ConversationEvent>;
export type PublicTurnDetails = Omit<Contract.TurnDetails, "turn"> & { turn: PublicImageTurn };
export type PublicTurnPage = Omit<Contract.TurnPage, "items"> & { items: PublicImageTurn[] };
export type PublicVersionPage = Omit<Contract.VersionPage, "items"> & { items: PublicImageVersion[] };
export type PublicCreateConversationResponse = Contract.ApiSuccess<PublicConversationSnapshot>;
export type PublicGetConversationResponse = Contract.ApiSuccess<PublicConversationSnapshot>;
export type PublicGetTurnResponse = Contract.ApiSuccess<PublicTurnDetails>;
export type PublicListTurnsResponse = Contract.ApiSuccess<PublicTurnPage>;
export type PublicListVersionsResponse = Contract.ApiSuccess<PublicVersionPage>;
export type PublicTurnSubmissionResponse = Contract.SubmitTurnResponse;
export type PublicCancelTurnResponse = Contract.CancelTurnResponse;

import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { compileConversationImagePrompt, deriveConversationRequestedState, resolveConversationVersion } from "../../shared/image-agent/conversation";
import type { EditPlan, ImageVersion, RequestedState } from "../../shared/image-conversation-contracts";

const state: RequestedState = { schemaVersion: 1, goals: ["针织衫改款"], constraints: [
  { key: "color", text: "衣身为酒红色", source: "user", sourceTurnId: null },
  { key: "neckline", text: "圆领", source: "user", sourceTurnId: null },
] };
function version(no: number, root?: ImageVersion, parent?: ImageVersion): ImageVersion {
  const id = randomUUID();
  return { id, conversationId: root?.conversationId ?? randomUUID(), rootVersionId: root?.id ?? id, parentVersionId: parent?.id ?? null,
    versionNo: no, imageNo: no + 10, label: `图${no + 10} · V${no}`, assetId: randomUUID(), source: root ? "generated" : "upload",
    turnId: root ? randomUUID() : null, outputIndex: 0, requestedState: structuredClone(state), observation: null, acceptance: "unreviewed",
    parameters: null, actualDimensions: { width: 2048, height: 2048 }, createdAt: new Date().toISOString() };
}
const edit = (extra: Partial<EditPlan> = {}): EditPlan => ({ action: "edit", assistantText: "仅改领口", base: { kind: "current" }, stateSource: "base",
  changes: [{ kind: "set", target: "neckline", instruction: "改为V领" }], preserve: [], revoke: [], references: [], outputIntent: { purpose: "standard", complexity: "low" }, ...extra });

describe("shared persisted conversation image semantics", () => {
  test("previous uses actual parent; original follows current work; explicit version never uses array position", () => {
    const a = version(1), a2 = version(2, a, a), a4 = version(4, a, a2), b = version(1);
    const versions = [b, a4, a, a2];
    expect(resolveConversationVersion(versions, a4.id, { kind: "previous" }).id).toBe(a2.id);
    expect(resolveConversationVersion(versions, a4.id, { kind: "original" }).id).toBe(a.id);
    expect(resolveConversationVersion(versions, b.id, { kind: "original" }).id).toBe(b.id);
    expect(resolveConversationVersion(versions, b.id, { kind: "version", versionId: a2.id }).versionNo).toBe(2);
    expect(() => resolveConversationVersion(versions, null, { kind: "current" })).toThrow();
    expect(() => resolveConversationVersion([a4], a4.id, { kind: "original" })).toThrow();
    expect(() => resolveConversationVersion(versions, a.id, { kind: "version", versionId: randomUUID() })).toThrow();
  });
  test("a set replaces the old same-key requirement, unrelated requirements remain immutable", () => {
    const turnId = randomUUID(), next = deriveConversationRequestedState(edit(), state, turnId, "改为V领");
    expect(next.constraints.find(item => item.key === "neckline")).toEqual({ key: "neckline", text: "改为V领", source: "confirmed_plan", sourceTurnId: turnId });
    expect(next.constraints.find(item => item.key === "color")).toEqual(state.constraints[0]);
    expect(state.constraints[1].text).toBe("圆领");
  });
  test("relative change executes once and is not stored as a replayable change on later edits", () => {
    const relative = edit({ changes: [{ kind: "relative", target: "neckline", instruction: "领口再宽一点" }] });
    const next = deriveConversationRequestedState(relative, state, randomUUID(), "领口再宽一点");
    expect(next.constraints.find(item => item.key === "neckline")?.text).not.toContain("再宽一点");
    const base = version(1); base.requestedState = next;
    const result = compileConversationImagePrompt({ plan: edit({ changes: [{ kind: "set", target: "color", instruction: "改成绿色" }] }),
      versions: [base], base, sourceState: next, sourceStateVersion: base, turnId: randomUUID(), userText: "改成绿色" });
    expect(result.prompt).not.toContain("再宽一点"); expect(result.prompt).toContain("不得再次执行相对增减");
  });
  test("revoked keys are removed, unsupported keys fail, inferred counts cannot become confirmed keep", () => {
    const next = deriveConversationRequestedState(edit({ revoke: ["color"] }), state, randomUUID(), "改为V领，不再保留酒红色");
    expect(next.constraints.some(item => item.key === "color")).toBe(false);
    expect(() => deriveConversationRequestedState(edit({ revoke: ["other-work"] }), state, randomUUID(), "改为V领")).toThrow();
    expect(() => deriveConversationRequestedState(edit({ preserve: ["保留7颗纽扣"] }), state, randomUUID(), "改为V领")).toThrow();
  });
  test("redo on original keeps original first and adds the effective-state version as a purpose-bound reference", () => {
    const original = version(1), latest = version(3, original, original);
    const result = compileConversationImagePrompt({ plan: edit({ base: { kind: "original" }, stateSource: "active" }), versions: [original, latest], base: original,
      sourceState: latest.requestedState, sourceStateVersion: latest, turnId: randomUUID(), userText: "从原图改为V领，保留酒红色" });
    expect(result.sources.map(item => item.id)).toEqual([original.id, latest.id]);
    expect(result.prompt).toContain("衣身为酒红色"); expect(result.prompt).toContain("不以该参考图替换实际底图");
  });
  test("foreign, duplicate or excess references are rejected without substitution", () => {
    const base = version(1), refs = Array.from({ length: 5 }, () => version(1));
    const compile = (plan: EditPlan) => compileConversationImagePrompt({ plan, versions: [base, ...refs], base,
      sourceState: state, sourceStateVersion: base, turnId: randomUUID(), userText: "改为V领" });
    expect(() => compile(edit({ references: [{ versionId: randomUUID(), role: "color", instruction: "配色" }] }))).toThrow();
    expect(() => compile(edit({ references: [{ versionId: base.id, role: "color", instruction: "配色" }] }))).toThrow();
    expect(() => compile(edit({ references: refs.map(ref => ({ versionId: ref.id, role: "color", instruction: "配色" })) }))).toThrow();
  });
});

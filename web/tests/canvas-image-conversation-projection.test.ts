import { expect, test } from "bun:test";
import { projectCanvasImageConversationVersion } from "@/lib/canvas/canvas-image-conversation-projection";
import { conversationVersionCanInstall } from "@/components/image-conversation-state";
import { conversationIds as ids, conversationTurn, conversationVersion } from "./fixtures/image-conversation";

const center = { x: 500, y: 300 };

test("server result projection preserves original asset and actual aspect ratio", () => {
    const version = { ...conversationVersion(true), actualDimensions: { width: 2048, height: 1024 } };
    const [node] = projectCanvasImageConversationVersion([], version, center);
    expect(node).toMatchObject({ width: 640, height: 320, metadata: { content: `/api/assets/${ids.resultAsset}/content`, serverAssetId: ids.resultAsset,
        naturalWidth: 2048, naturalHeight: 1024, imageConversation: { conversationId: ids.conversation, versionId: ids.generated, assetId: ids.resultAsset, turnId: ids.turn } } });
});

test("duplicate SSE and JSON-restored canvas metadata cannot install a version twice", () => {
    const version = conversationVersion(true), initial = projectCanvasImageConversationVersion([], version, center);
    expect(projectCanvasImageConversationVersion(initial, version, center)).toBe(initial);
    const restored = JSON.parse(JSON.stringify(initial));
    expect(projectCanvasImageConversationVersion(restored, version, center)).toBe(restored);
    expect(restored).toHaveLength(1);
});

test("two conversations do not share projection identity even when image labels or version numbers match", () => {
    const version = conversationVersion(true), first = projectCanvasImageConversationVersion([], version, center);
    const second = { ...version, conversationId: "82000000-0000-4000-8000-000000000001" };
    const result = projectCanvasImageConversationVersion(first, second, center);
    expect(result).toHaveLength(2);
    expect(result[0]!.id).not.toBe(result[1]!.id);
    expect(result[0]!.metadata!.imageConversation!.conversationId).toBe(ids.conversation);
    expect(result[1]!.metadata!.imageConversation!.conversationId).toBe(second.conversationId);
});

test("uploads, unresolved dimensions and changed asset identity never become invented result nodes", () => {
    const nodes = projectCanvasImageConversationVersion([], conversationVersion(), center);
    expect(nodes).toHaveLength(0);
    expect(() => projectCanvasImageConversationVersion([], { ...conversationVersion(true), actualDimensions: null }, center)).toThrow("实际尺寸");
    const existing = projectCanvasImageConversationVersion([], conversationVersion(true), center);
    expect(() => projectCanvasImageConversationVersion(existing, { ...conversationVersion(true), assetId: ids.asset }, center)).toThrow("身份");
});

test("only the verified completed original turn may automatically install its generated version", () => {
    const version = conversationVersion(true), turn = conversationTurn("completed");
    expect(conversationVersionCanInstall(version, turn)).toBe(true);
    expect(conversationVersionCanInstall(conversationVersion(), turn)).toBe(false);
    expect(conversationVersionCanInstall(version, conversationTurn("accepted"))).toBe(false);
    expect(conversationVersionCanInstall(version, { ...turn, autoActivate: false })).toBe(false);
    expect(conversationVersionCanInstall(version, { ...turn, state: "detached" })).toBe(false);
    expect(conversationVersionCanInstall(version, { ...turn, conversationId: "different-conversation" })).toBe(false);
    expect(conversationVersionCanInstall(version, { ...turn, id: "different-turn" })).toBe(false);
    expect(conversationVersionCanInstall(version, { ...turn, outputVersionId: ids.root })).toBe(false);
});

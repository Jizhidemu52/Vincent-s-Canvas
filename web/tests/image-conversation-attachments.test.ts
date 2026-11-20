import { expect, test } from "bun:test";
import { mergeConversationAttachments, conversationRequestAttachments } from "@/components/image-conversation-state";

const asset = (index: number) => `a1000000-0000-4000-8000-${String(index).padStart(12, "0")}`;

test("explicit base selection retains references and replaces only the base role", () => {
    const original = [
        { assetId: asset(1), name: "第一张", purpose: "new_base" as const },
        { assetId: asset(2), name: "参考", purpose: "reference" as const },
    ];
    const next = mergeConversationAttachments(original, [{ assetId: asset(3), name: "新底图", purpose: "new_base" }]);
    expect(next).toEqual([
        { ...original[0], purpose: "reference" },
        original[1],
        { assetId: asset(3), name: "新底图", purpose: "new_base" },
    ]);
    expect(original[0].purpose).toBe("new_base");
});

test("reselecting an existing asset never duplicates it or silently loses its base role", () => {
    const original = [{ assetId: asset(1), name: "底图", purpose: "new_base" as const }];
    expect(mergeConversationAttachments(original, [{ assetId: asset(1), name: "重新选择" }])).toEqual([
        { ...original[0], name: "重新选择" },
    ]);
    expect(
        mergeConversationAttachments(original, [{ assetId: asset(1), name: "仅参考", purpose: "reference" }]),
    ).toEqual([{ assetId: asset(1), name: "仅参考", purpose: "reference" }]);
});

test("invalid multi-base, conflicting duplicate and overflow batches fail without truncation", () => {
    expect(() =>
        mergeConversationAttachments(
            [],
            [
                { assetId: asset(1), name: "一", purpose: "new_base" },
                { assetId: asset(2), name: "二", purpose: "new_base" },
            ],
        ),
    ).toThrow("一张");
    expect(() =>
        mergeConversationAttachments(
            [],
            [
                { assetId: asset(1), name: "一", purpose: "new_base" },
                { assetId: asset(1), name: "一", purpose: "reference" },
            ],
        ),
    ).toThrow("重复");
    const full = Array.from({ length: 16 }, (_, index) => ({ assetId: asset(index), name: String(index) }));
    expect(() => mergeConversationAttachments(full, [{ assetId: asset(17), name: "多余" }])).toThrow("16");
    expect(full).toHaveLength(16);
    expect(mergeConversationAttachments(full, [{ assetId: asset(0), name: "原件" }])).toHaveLength(16);
});

test("request serialization retains explicit roles and defaults legacy drafts to auto", () => {
    expect(
        conversationRequestAttachments([
            { assetId: asset(1), name: "旧草稿" },
            { assetId: asset(2), name: "新底图", purpose: "new_base" },
        ]),
    ).toEqual([
        { assetId: asset(1), purpose: "auto" },
        { assetId: asset(2), purpose: "new_base" },
    ]);
});

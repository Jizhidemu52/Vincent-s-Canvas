import { i18nHarness } from "./helpers/i18n-harness";
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import ts from "typescript";
import type { PromptTemplate } from "@/services/api/prompts";
import type { usePromptFavoriteList } from "@/components/prompts/use-prompt-favorite-list";

const source = readFileSync(new URL("../src/components/prompts/use-prompt-favorite-list.ts", import.meta.url), "utf8");
const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ESNext } }).outputText;
type Options = Parameters<typeof usePromptFavoriteList>[0];
const item = (id: string, favorite = false) => ({ id, title: id, favorite } as PromptTemplate);
const deferred = <T,>() => Promise.withResolvers<T>();

function harness(patch: Partial<Options> = {}, write: (id: string, favorite: boolean) => Promise<{ favorite: boolean }> = async (_id, favorite) => ({ favorite })) {
    const cells: Array<{ value: unknown; deps?: unknown[]; cleanup?: () => void }> = [];
    let cursor = 0, effects: Array<() => void> = [], ownerId: string | undefined = "owner-a";
    const writes: Array<{ id: string; favorite: boolean }> = [], reads: number[][] = [], pages: number[] = [], errors: string[] = [];
    let options: Options = {
        ownerId, viewKey: "view-a", page: 1, pageSize: 2, loading: false,
        setPage: (value) => pages.push(typeof value === "function" ? value(options.page) : value),
        readPage: async (page, size) => { reads.push([page, size]); return { templates: [item("c", true)], total: 2 }; },
        onRefreshError: (message) => errors.push(message), ...patch,
    };
    const equal = (left: unknown[] | undefined, right: unknown[]) => left?.length === right.length && right.every((value, index) => Object.is(value, left[index]));
    const memo = (create: () => unknown, deps: unknown[]) => {
        const index = cursor++;
        if (!cells[index] || !equal(cells[index].deps, deps)) cells[index] = { value: create(), deps };
        return cells[index].value;
    };
    const dependencies: Record<string, unknown> = {
        "@/lib/i18n": i18nHarness,
        react: {
            useState: (initial: unknown) => {
                const index = cursor++;
                cells[index] ||= { value: typeof initial === "function" ? initial() : initial };
                return [cells[index].value, (value: unknown) => { cells[index].value = typeof value === "function" ? value(cells[index].value) : value; }];
            },
            useRef: (initial: unknown) => { const index = cursor++; cells[index] ||= { value: { current: initial } }; return cells[index].value; },
            useMemo: memo, useCallback: (fn: unknown, deps: unknown[]) => memo(() => fn, deps),
            useEffect: (effect: () => () => void, deps: unknown[]) => {
                const index = cursor++, previous = cells[index];
                if (previous && equal(previous.deps, deps)) return;
                cells[index] = { value: undefined, deps };
                effects.push(() => { previous?.cleanup?.(); cells[index].cleanup = effect(); });
            },
        },
        "@/services/api/prompts": { setPromptFavorite: (id: string, favorite: boolean) => { writes.push({ id, favorite }); return write(id, favorite); } },
        "@/stores/use-user-store": { useUserStore: { getState: () => ({ user: ownerId ? { id: ownerId } : null }) } },
    };
    const module = { exports: {} as { usePromptFavoriteList: typeof usePromptFavoriteList } };
    new Function("require", "module", "exports", code)((name: string) => {
        if (!Object.hasOwn(dependencies, name)) throw new Error(`Unexpected dependency: ${name}`);
        return dependencies[name];
    }, module, module.exports);
    let result: ReturnType<typeof usePromptFavoriteList>;
    const render = (next: Partial<Options> = {}) => {
        options = { ...options, ...next }; cursor = 0; effects = [];
        result = module.exports.usePromptFavoriteList(options);
        effects.forEach(effect => effect());
        return result;
    };
    render();
    return { writes, reads, pages, errors, render, result: () => result,
        accept: (templates: PromptTemplate[], total = templates.length) => { result.accept({ templates, total }); return render(); },
        owner: (id?: string) => { ownerId = id; return render({ ownerId: id }); },
        unmount: () => { cells.forEach(cell => cell.cleanup?.()); },
    };
}

describe("prompt favorites update in place", () => {
    test("uses the API's returned favorite without changing order or total or reading the list", async () => {
        const h = harness({}, async () => ({ favorite: false }));
        const initial = [item("a"), item("b")]; h.accept(initial, 9);
        await h.result().onFavorite(initial[0]);
        const result = h.render();
        expect(h.writes).toEqual([{ id: "a", favorite: true }]);
        expect(result.items.map(value => [value.id, value.favorite])).toEqual([["a", false], ["b", false]]);
        expect(result.items[1]).toBe(initial[1]);
        expect(result.total).toBe(9); expect(h.reads).toEqual([]);
    });

    test("rapid duplicate clicks share one request and list reads wait for all queued writes", async () => {
        const first = deferred<{ favorite: boolean }>(), second = deferred<{ favorite: boolean }>(), entered = deferred<void>();
        const h = harness({}, (id) => { if (id === "a") { entered.resolve(); return first.promise; } return second.promise; });
        const items = [item("a"), item("b")]; h.accept(items);
        const a = h.result().onFavorite(items[0]), duplicate = h.result().onFavorite(items[0]), b = h.result().onFavorite(items[1]);
        await entered.promise;
        let settled = false; const waiting = h.result().waitForPending().then(() => { settled = true; });
        expect(h.writes).toHaveLength(1);
        first.resolve({ favorite: true }); await a; await duplicate;
        expect(settled).toBe(false);
        second.resolve({ favorite: true }); await b; await waiting;
        expect(h.writes).toEqual([{ id: "a", favorite: true }, { id: "b", favorite: true }]);
        expect(h.render().items.every(value => value.favorite)).toBe(true);
    });

    test("favorites-only removes one result and backfills only the shifted row", async () => {
        const h = harness({ favoriteOnly: true }); const items = [item("a", true), item("b", true)]; h.accept(items, 3);
        await h.result().onFavorite(items[0]);
        const result = h.render();
        expect(result.items.map(value => value.id)).toEqual(["b", "c"]);
        expect(result.total).toBe(2); expect(h.reads).toEqual([[2, 1]]); expect(h.pages).toEqual([]);
    });

    test("removing the last result on a trailing page clamps the page without a stale refill", async () => {
        const h = harness({ favoriteOnly: true, page: 2 }); const last = item("last", true); h.accept([last], 3);
        await h.result().onFavorite(last);
        expect(h.render().total).toBe(2); expect(h.result().items).toEqual([]);
        expect(h.pages).toEqual([1]); expect(h.reads).toEqual([]);
    });

    test("removing the final favorite reaches a zero total, never negative or page zero", async () => {
        const h = harness({ favoriteOnly: true }); const last = item("last", true); h.accept([last], 1);
        await h.result().onFavorite(last);
        expect(h.render().total).toBe(0); expect(h.result().items).toEqual([]);
        expect(h.pages).toEqual([]); expect(h.reads).toEqual([]);
    });

    test("failed writes preserve the card and allow a later retry", async () => {
        let fail = true;
        const h = harness({}, async (_id, favorite) => { if (fail) throw new Error("收藏服务暂不可用"); return { favorite }; });
        const a = item("a"); h.accept([a]);
        await expect(h.result().onFavorite(a)).rejects.toThrow("收藏服务暂不可用");
        expect(h.render().items).toEqual([a]); expect(h.reads).toEqual([]);
        fail = false; await h.result().onFavorite(a);
        expect(h.render().items[0].favorite).toBe(true);
    });

    test("a refill failure reports that the favorite was saved, retaining the new count", async () => {
        const h = harness({ favoriteOnly: true, readPage: async () => { throw new Error("网络中断"); } });
        const items = [item("a", true), item("b", true)]; h.accept(items, 3);
        await h.result().onFavorite(items[0]);
        expect(h.render().items.map(value => value.id)).toEqual(["b"]); expect(h.result().total).toBe(2);
        expect(h.errors).toEqual(["收藏状态已保存，但补齐列表失败：网络中断"]);
    });

    test.each(["view", "owner", "owner-return", "logout", "unmount"])("%s changes cannot receive an old favorite response or error", async change => {
        const response = deferred<{ favorite: boolean }>(), entered = deferred<void>();
        const h = harness({}, () => { entered.resolve(); return response.promise; });
        const a = item("a"); h.accept([a]); const pending = h.result().onFavorite(a); await entered.promise;
        if (change === "view") h.render({ viewKey: "another-query" });
        if (change === "owner" || change === "owner-return") h.owner("owner-b");
        if (change === "owner-return") h.owner("owner-a");
        if (change === "logout") h.owner(undefined);
        if (change === "unmount") h.unmount();
        response.resolve({ favorite: true }); await pending;
        expect(h.render().items.find(value => value.id === "a")?.favorite).not.toBe(true);
        expect(h.errors).toEqual([]); expect(h.reads).toEqual([]);
    });

    test("new owners do not wait for an old owner's in-flight mutation", async () => {
        const response = deferred<{ favorite: boolean }>(), entered = deferred<void>();
        const h = harness({}, () => { entered.resolve(); return response.promise; });
        const a = item("a"); h.accept([a]); const pending = h.result().onFavorite(a); await entered.promise;
        h.owner("owner-b"); await h.result().waitForPending();
        response.reject(new Error("旧账号失败")); await pending;
        expect(h.render().items).toEqual([]);
    });

    test("loading and a changed filter's debounce gap do not mutate an unrelated visible list", async () => {
        const h = harness(); const a = item("a"); h.accept([a]);
        h.render({ loading: true }); await expect(h.result().onFavorite(a)).rejects.toThrow("正在更新");
        h.render({ loading: false, viewKey: "new-filter" }); await expect(h.result().onFavorite(a)).rejects.toThrow("正在更新");
        expect(h.writes).toEqual([]);
    });

    test("a late list accept cannot replace the current view or current owner", () => {
        const h = harness(); const oldAccept = h.result().accept;
        h.render({ viewKey: "new-filter" }); h.accept([item("current")]);
        oldAccept({ templates: [item("old")], total: 9 });
        expect(h.render().items.map(value => value.id)).toEqual(["current"]);
        h.owner("owner-b"); oldAccept({ templates: [item("old-owner")], total: 9 });
        expect(h.render().items).toEqual([]);
    });
});

import { expect, test } from "bun:test";
import { createPromptListLoader } from "../src/lib/prompt-list-loader";

test("the latest prompt search wins even when the older request finishes last", async () => {
    const loader = createPromptListLoader();
    const results: string[] = [];
    const loading: boolean[] = [];
    let finishOld!: (value: string) => void;
    const old = loader.load(() => new Promise<string>((resolve) => { finishOld = resolve; }), (value) => results.push(value), () => {}, (value) => loading.push(value));
    await loader.load(async () => "new search", (value) => results.push(value), () => {}, (value) => loading.push(value));
    finishOld("old search");
    await old;
    expect(results).toEqual(["new search"]);
    expect(loading).toEqual([true, true, false]);
});

test("changing a filter invalidates the in-flight request during the debounce gap", async () => {
    const loader = createPromptListLoader();
    const events: unknown[] = [];
    let reject!: (error: Error) => void;
    const pending = loader.load(() => new Promise<string>((_resolve, fail) => { reject = fail; }), (value) => events.push(value), (error) => events.push(error), (value) => events.push(value));
    loader.invalidate();
    reject(new Error("outdated network error"));
    await pending;
    expect(events).toEqual([true]);
});

test("a current request failure ends its loading state and reports the real error", async () => {
    const loader = createPromptListLoader();
    const error = new Error("offline");
    const errors: unknown[] = [];
    const loading: boolean[] = [];
    await loader.load(async () => { throw error; }, () => {}, (value) => errors.push(value), (value) => loading.push(value));
    expect(errors).toEqual([error]);
    expect(loading).toEqual([true, false]);
});

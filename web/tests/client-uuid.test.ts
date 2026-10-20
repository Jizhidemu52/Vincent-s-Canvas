import { expect, test } from "bun:test";
import { validate, version } from "uuid";
import { createClientUuid } from "../src/lib/client-uuid";
import { createClientId } from "../src/lib/client-id";

test("HTTP crypto creates unique RFC v4 UUIDs without the HTTPS-only method", () => {
    const httpCrypto = { getRandomValues: crypto.getRandomValues.bind(crypto) };
    const ids = Array.from({ length: 1000 }, () => createClientUuid(httpCrypto));
    expect(new Set(ids).size).toBe(1000);
    for (const id of ids) { expect(validate(id)).toBe(true); expect(version(id)).toBe(4); }
    expect(validate(createClientId(httpCrypto))).toBe(true);
});

test("native secure-context UUID generation remains supported", () => {
    const id = "00112233-4455-4677-8899-aabbccddeeff";
    expect(createClientUuid({ randomUUID: () => id })).toBe(id);
});

test("UUID records never fall back to non-UUID or weak random identifiers", () => {
    expect(() => createClientUuid({})).toThrow("secure random generation is unavailable");
});

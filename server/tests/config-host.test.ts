import { expect, test } from "bun:test";
import { loadConfig } from "../src/config";

const connections = { DATABASE_URL: "postgres://localhost/test", REDIS_URL: "redis://localhost" };

test("formal API keeps its existing default binding unless an explicit host is supplied", () => {
    expect(loadConfig(connections).HOST).toBeUndefined();
    expect(loadConfig({ ...connections, HOST: "127.0.0.1" }).HOST).toBe("127.0.0.1");
    expect(() => loadConfig({ ...connections, HOST: "" })).toThrow();
});

test("provider image HTTP origin is opt-in and rejects unsafe or non-origin configuration", () => {
    expect(loadConfig(connections).PROVIDER_IMAGE_PUBLIC_ORIGIN).toBeUndefined();
    expect(loadConfig({ ...connections, PROVIDER_IMAGE_PUBLIC_ORIGIN: "" }).PROVIDER_IMAGE_PUBLIC_ORIGIN).toBe("");
    expect(loadConfig({ ...connections, PROVIDER_IMAGE_PUBLIC_ORIGIN: " HTTP://ai.in-choice.com.cn/ " }).PROVIDER_IMAGE_PUBLIC_ORIGIN)
        .toBe("http://ai.in-choice.com.cn");
    for (const origin of ["http://127.0.0.1", "http://192.168.3.117", "http://user:secret@images.example.com",
        "http://images.example.com/path", "http://images.example.com?key=secret", "ftp://images.example.com"]) {
        expect(() => loadConfig({ ...connections, PROVIDER_IMAGE_PUBLIC_ORIGIN: origin })).toThrow();
    }
});

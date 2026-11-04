import { expect, test } from "bun:test";
import { loadConfig } from "../src/config";

const connections = { DATABASE_URL: "postgres://localhost/test", REDIS_URL: "redis://localhost" };

test("formal API keeps its existing default binding unless an explicit host is supplied", () => {
    expect(loadConfig(connections).HOST).toBeUndefined();
    expect(loadConfig({ ...connections, HOST: "127.0.0.1" }).HOST).toBe("127.0.0.1");
    expect(() => loadConfig({ ...connections, HOST: "" })).toThrow();
});

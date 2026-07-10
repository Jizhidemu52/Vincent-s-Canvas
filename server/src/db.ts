import pg from "pg";
import { createClient } from "redis";

const { Pool } = pg;

export type Database = pg.Pool;
export type Cache = {
    get(key: string): Promise<string | null>;
    set(key: string, value: string, options?: { EX: number }): Promise<unknown>;
    del(key: string): Promise<unknown>;
    ping(): Promise<string>;
    quit(): Promise<string>;
};

export function createDatabase(connectionString: string) {
    return new Pool({ connectionString, max: 20, idleTimeoutMillis: 30_000 });
}

export async function createCache(url: string) {
    const client = createClient({ url });
    client.on("error", (error) => console.error("Redis error", error));
    await client.connect();
    return client;
}

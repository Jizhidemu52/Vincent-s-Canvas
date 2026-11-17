import { expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

test("browser product code uses the HTTP-compatible UUID and hashing implementations", () => {
    const root = fileURLToPath(new URL("../src/", import.meta.url));
    const violations: string[] = [];
    const visit = (directory: string) => {
        for (const entry of readdirSync(directory, { withFileTypes: true })) {
            const file = join(directory, entry.name);
            if (entry.isDirectory()) visit(file);
            else if (/\.(?:[cm]?[jt]s|[jt]sx)$/.test(file)) {
                const source = readFileSync(file, "utf8");
                if (/\bcrypto\s*\.\s*randomUUID\s*\(|\bcrypto\s*\.\s*subtle\s*\.\s*digest\s*\(/.test(source)) violations.push(relative(root, file));
            }
        }
    };
    visit(root);
    expect(violations).toEqual([]);
});

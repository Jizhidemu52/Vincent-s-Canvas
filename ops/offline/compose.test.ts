import { expect, test } from "bun:test";
import { offlineCompose } from "./compose";
const source = Bun.YAML.parse(await Bun.file(new URL("../../docker-compose.yml", import.meta.url)).text()) as any;
const revision = "a".repeat(40);
test("all eight services run offline using seven explicit image references", () => {
    const config = offlineCompose(source, revision);
    expect(Object.keys(config.services)).toHaveLength(8);
    expect(new Set(Object.values(config.services).map(s => s.image)).size).toBe(7);
    for (const service of Object.values(config.services)) {
        expect(service.build).toBeUndefined();
        expect(service.pull_policy).toBe("never");
        expect(service.image).toBeTruthy();
    }
    expect(config.services.api.image).toBe(config.services.worker.image);
    expect(config.services.web.ports).toEqual(["127.0.0.1:3300:3000"]);
    expect(config.services.api.environment).toEqual(source.services.api.environment);
    expect(config.volumes).toEqual(source.volumes);
    expect(source.services.web.build).toBeDefined();
});
test("preserves service commands, healthchecks and initialization ordering", () => {
    const config = offlineCompose(source, revision);
    for (const name of Object.keys(source.services)) {
        for (const key of ["command", "healthcheck", "depends_on", "volumes", "env_file"]) {
            expect(config.services[name][key]).toEqual(source.services[name][key]);
        }
    }
});
test("rejects unsafe revisions and unmapped future build services", () => {
    expect(() => offlineCompose(source, "latest")).toThrow();
    expect(() => offlineCompose({services:{newService:{build:"."}}}, revision)).toThrow("Unmapped");
});

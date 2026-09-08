type Service = Record<string, any>;
export function offlineCompose(source: { services: Record<string, Service>; [key: string]: any }, revision: string) {
    if (!/^[a-f0-9]{40}$/.test(revision)) throw new Error("Expected a full Git commit SHA");
    const result = structuredClone(source);
    const built: Record<string, string> = {
        web: `wireless-canvas-web:${revision}`,
        api: `wireless-canvas-server:${revision}`,
        worker: `wireless-canvas-server:${revision}`,
        backup: `wireless-canvas-backup:${revision}`,
    };
    for (const [name, service] of Object.entries(result.services)) {
        if (service.build && !built[name]) throw new Error(`Unmapped build service: ${name}`);
        delete service.build;
        delete service.container_name;
        service.image = built[name] || service.image;
        if (!service.image) throw new Error(`Missing image: ${name}`);
        service.pull_policy = "never";
        service.logging = { driver: "json-file", options: { "max-size": "20m", "max-file": "5" } };
    }
    result.services.web.ports = ["127.0.0.1:3300:3000"];
    return result;
}

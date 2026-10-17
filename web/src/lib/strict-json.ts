import { parser } from "@lezer/json";

export class DuplicateJsonKeyError extends SyntaxError {
    readonly code = "DUPLICATE_JSON_KEY";
    readonly submitted = false;
    constructor() {
        super("工具参数包含重复 JSON 键，不能确定完整要求，已停止执行。");
        this.name = "DuplicateJsonKeyError";
    }
}

/** Preserve no ambiguous last-key-wins data. Lezer supplies the grammar; JSON.parse supplies values. */
export function parseStrictJson(source: string): unknown {
    const objects: Set<string>[] = [];
    parser.parse(source).iterate({
        enter(node) {
            if (node.type.isError) throw new SyntaxError("工具参数不是有效 JSON");
            if (node.name === "Object") objects.push(new Set());
            if (node.name !== "PropertyName") return;
            const keys = objects[objects.length - 1];
            if (!keys) throw new SyntaxError("工具参数不是有效 JSON");
            // Decode escaped keys with the native parser, so preserve and pre\u0073erve are identical.
            const key = JSON.parse(source.slice(node.from, node.to)) as string;
            if (keys.has(key)) throw new DuplicateJsonKeyError();
            keys.add(key);
        },
        leave(node) { if (node.name === "Object") objects.pop(); },
    });
    return JSON.parse(source) as unknown;
}

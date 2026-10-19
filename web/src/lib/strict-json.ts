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

/** Recover only additive root preserve strings from a known create_image call. */
export function parseCreateImageArguments(source: string): unknown {
    try { return parseStrictJson(source); }
    catch (error) { if (!(error instanceof DuplicateJsonKeyError)) throw error; }

    // Inspect the complete grammar before parsing values. The strict attempt may
    // have stopped at a duplicate before reaching a later syntax error.
    const tree = parser.parse(source);
    const root = tree.topNode.firstChild;
    if (root?.name !== "Object") throw new DuplicateJsonKeyError();
    const objects: Set<string>[] = [];
    tree.iterate({
        enter(node) {
            if (node.type.isError) throw new SyntaxError("工具参数不是有效 JSON");
            if (node.name === "Object") objects.push(new Set());
            if (node.name !== "PropertyName") return;
            const keys = objects[objects.length - 1];
            if (!keys) throw new SyntaxError("工具参数不是有效 JSON");
            const key = JSON.parse(source.slice(node.from, node.to)) as string;
            if (keys.has(key) && !(objects.length === 1 && key === "preserve")) throw new DuplicateJsonKeyError();
            keys.add(key);
        },
        leave(node) { if (node.name === "Object") objects.pop(); },
    });

    const properties = root.getChildren("Property").map(property => ({
        key: JSON.parse(source.slice(property.firstChild!.from, property.firstChild!.to)) as string,
        value: property.lastChild!,
    }));
    const readValue = (property: typeof properties[number]): unknown => JSON.parse(source.slice(property.value.from, property.value.to));
    const actionProperty = properties.find(property => property.key === "action");
    const action = actionProperty && readValue(actionProperty);
    if (action !== "generate" && action !== "edit") throw new DuplicateJsonKeyError();
    const preserve = properties.filter(property => property.key === "preserve").map(readValue);
    if (preserve.length < 2 || preserve.length > 20
        || preserve.some(value => typeof value !== "string" || !value.trim() || value.length > 400)) throw new DuplicateJsonKeyError();

    // Never parse the duplicate-bearing root with last-key-wins semantics. All
    // remaining keys are unique; source-ordered constraints retain every byte of
    // their decoded strings, including whitespace and repeated identical values.
    return Object.fromEntries([
        ...properties.filter(property => property.key !== "preserve").map(property => [property.key, readValue(property)]),
        ["preserve", preserve],
    ]);
}

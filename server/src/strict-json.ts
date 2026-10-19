import { parser } from "@lezer/json";

export class DuplicateJsonKeyError extends SyntaxError {
  constructor() {
    super("JSON 对象包含重复键");
    this.name = "DuplicateJsonKeyError";
  }
}

/** Reject ambiguous native tool objects before JSON.parse can discard earlier keys. */
export function parseStrictJson(source: string): unknown {
  const objects: Set<string>[] = [];
  parser.parse(source).iterate({
    enter(node) {
      if (node.type.isError) throw new SyntaxError("无效 JSON");
      if (node.name === "Object") objects.push(new Set());
      if (node.name !== "PropertyName") return;
      const keys = objects[objects.length - 1];
      if (!keys) throw new SyntaxError("无效 JSON");
      // Escaped names such as pre\u0073erve are the same property as preserve.
      const key = JSON.parse(source.slice(node.from, node.to)) as string;
      if (keys.has(key)) throw new DuplicateJsonKeyError();
      keys.add(key);
    },
    leave(node) { if (node.name === "Object") objects.pop(); },
  });
  return JSON.parse(source) as unknown;
}

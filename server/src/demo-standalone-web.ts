import { resolve, sep } from "node:path";

export function resolveStandaloneStaticPath(rootDirectory: string, pathname: string) {
  const root = resolve(rootDirectory);
  const relativePath = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const candidate = resolve(root, relativePath);
  return candidate === root || candidate.startsWith(`${root}${sep}`) ? candidate : null;
}

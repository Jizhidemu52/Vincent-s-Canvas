/** Personal creation is separate from administrative scope and OA employee identity. */
export function isWorkspaceRole(role: unknown): role is "designer" | "super_admin" {
    return role === "designer" || role === "super_admin";
}

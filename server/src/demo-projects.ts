export function syncDemoProject(input: { externalId?: string; name?: string }) {
  const externalId = input.externalId?.trim();
  const name = input.name?.trim();
  if (!externalId || !name) throw new Error("Project identity is required");
  return { project: { externalId, name, syncedAt: new Date().toISOString() } };
}

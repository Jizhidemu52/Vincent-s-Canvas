export function normalizeDemoPublicAssetOrigin(value: string | undefined) {
  const candidate = value?.trim();
  if (!candidate) return "";
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new Error("DEMO_PUBLIC_ASSET_ORIGIN must be an https URL");
  }
  if (parsed.protocol !== "https:")
    throw new Error("DEMO_PUBLIC_ASSET_ORIGIN must be an https URL");
  return parsed.origin;
}

export function createDemoPublicAssetUrl(origin: string, assetId: string, accessToken: string) {
  const url = new URL(`/api/assets/${encodeURIComponent(assetId)}/content`, origin);
  url.searchParams.set("video_access", accessToken);
  return url.toString();
}

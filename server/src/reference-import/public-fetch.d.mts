export class PublicFetchError extends Error { status: number; code: string; constructor(status: number, code: string, message: string); }
export function validatePublicUrl(input: string): URL;
export function isPublicAddress(address: string): boolean;
export function resolvePublicAddress(url: URL, resolver?: (hostname: string, options: { all: true; verbatim: true }) => Promise<{ address: string; family: number }[]>): Promise<{ address: string; family: number }>;

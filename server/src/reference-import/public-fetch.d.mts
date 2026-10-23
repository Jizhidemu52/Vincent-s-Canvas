export class PublicFetchError extends Error { status: number; code: string; httpStatus?: number; constructor(status: number, code: string, message: string, httpStatus?: number); }
export function validatePublicUrl(input: string): URL;
export function isPublicAddress(address: string): boolean;
export function resolvePublicAddress(url: URL, resolver?: (hostname: string, options: { all: true; verbatim: true }) => Promise<{ address: string; family: number }[]>): Promise<{ address: string; family: number }>;

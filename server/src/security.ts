import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import argon2 from "argon2";

export const MIN_PASSWORD_LENGTH = 12;

export function validatePassword(password: string) {
    if (password.length < MIN_PASSWORD_LENGTH) return `密码至少需要 ${MIN_PASSWORD_LENGTH} 位`;
    if (!/[A-Za-z]/.test(password) || !/\d/.test(password)) return "密码必须同时包含字母和数字";
    return null;
}

export function hashPassword(password: string) {
    return argon2.hash(password, { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 });
}

export function verifyPassword(hash: string, password: string) {
    return argon2.verify(hash, password);
}

export function createSessionToken() {
    return { id: randomUUID(), token: randomBytes(32).toString("base64url") };
}

export function hashToken(token: string) {
    return createHash("sha256").update(token).digest("hex");
}

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function createTotpSecret() {
    const bytes = randomBytes(20);
    let bits = "";
    for (const byte of bytes) bits += byte.toString(2).padStart(8, "0");
    let result = "";
    for (let index = 0; index < bits.length; index += 5) result += BASE32[Number.parseInt(bits.slice(index, index + 5).padEnd(5, "0"), 2)];
    return result;
}

function decodeBase32(value: string) {
    let bits = "";
    for (const char of value.replace(/=+$/g, "").toUpperCase()) {
        const index = BASE32.indexOf(char);
        if (index < 0) throw new Error("Invalid base32 secret");
        bits += index.toString(2).padStart(5, "0");
    }
    const bytes: number[] = [];
    for (let index = 0; index + 8 <= bits.length; index += 8) bytes.push(Number.parseInt(bits.slice(index, index + 8), 2));
    return Buffer.from(bytes);
}

export function totpCode(secret: string, timestamp = Date.now()) {
    const counter = Math.floor(timestamp / 30_000);
    const buffer = Buffer.alloc(8);
    buffer.writeBigUInt64BE(BigInt(counter));
    const digest = createHmac("sha1", decodeBase32(secret)).update(buffer).digest();
    const offset = digest[digest.length - 1]! & 0x0f;
    const binary = ((digest[offset]! & 0x7f) << 24) | ((digest[offset + 1]! & 0xff) << 16) | ((digest[offset + 2]! & 0xff) << 8) | (digest[offset + 3]! & 0xff);
    return String(binary % 1_000_000).padStart(6, "0");
}

export function verifyTotp(secret: string, code: string, timestamp = Date.now()) {
    return [-1, 0, 1].some((window) => totpCode(secret, timestamp + window * 30_000) === code);
}

export function encryptSecret(value: string, base64Key: string) {
    const key = Buffer.from(base64Key, "base64");
    if (key.length !== 32) throw new Error("MFA encryption key must be 32 bytes");
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    return [iv, cipher.getAuthTag(), encrypted].map((part) => part.toString("base64url")).join(".");
}

export function decryptSecret(payload: string, base64Key: string) {
    const key = Buffer.from(base64Key, "base64");
    const [iv, tag, encrypted] = payload.split(".").map((part) => Buffer.from(part!, "base64url"));
    const decipher = createDecipheriv("aes-256-gcm", key, iv!);
    decipher.setAuthTag(tag!);
    return Buffer.concat([decipher.update(encrypted!), decipher.final()]).toString("utf8");
}

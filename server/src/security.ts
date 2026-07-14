import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
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

export function encryptSecret(value: string, base64Key: string) {
    const key = Buffer.from(base64Key, "base64");
    if (key.length !== 32) throw new Error("Encryption key must be 32 bytes");
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

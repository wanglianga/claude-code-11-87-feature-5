// ============================================================
// 规范化 JSON + SHA-256 + HMAC 演示签名
// 哈希使用纯 TS 实现（见 sha256.ts），在非安全上下文的 HTTP
// 部署与 WebWorker / Node 测试环境中行为一致。
// 生产环境签名密钥应由 HSM / KMS 持有，这里用固定演示密钥。
// ============================================================

import { bytesToHex, hmacSha256HexSync, sha256Bytes, sha256HexSync } from './sha256';

export const DEMO_SIGNING_SECRET = 'dcp-demo-signing-key-2026-not-for-production';

/** 递归按 key 排序的规范化 JSON，保证哈希与签名可复现 */
export function canonicalStringify(value: unknown): string {
  return JSON.stringify(sortDeep(value));
}

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v !== undefined) out[key] = sortDeep(v);
    }
    return out;
  }
  return value;
}

export async function sha256Hex(data: string | Uint8Array): Promise<string> {
  if (typeof data === 'string') return sha256HexSync(data);
  return bytesToHex(sha256Bytes(data));
}

export async function sha256Canonical(value: unknown): Promise<string> {
  return sha256HexSync(canonicalStringify(value));
}

export async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  return hmacSha256HexSync(secret, message);
}

export async function signPayload(payload: unknown): Promise<string> {
  return hmacSha256HexSync(DEMO_SIGNING_SECRET, canonicalStringify(payload));
}

export async function verifyPayloadSignature(payload: unknown, signature: string): Promise<boolean> {
  const expected = hmacSha256HexSync(DEMO_SIGNING_SECRET, canonicalStringify(payload));
  if (expected.length !== signature.length) return false;
  let mismatch = 0;
  for (let i = 0; i < expected.length; i++) mismatch |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  return mismatch === 0;
}

/** 生成带前缀的 ID */
export function uid(prefix: string): string {
  const time = Date.now().toString(36);
  let rand: string;
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
    const arr = crypto.getRandomValues(new Uint32Array(2));
    rand = arr[0].toString(36) + arr[1].toString(36);
  } else {
    rand = Math.random().toString(36).slice(2, 10);
  }
  return `${prefix}_${time}${rand}`;
}

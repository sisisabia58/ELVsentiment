import { randomBytes, scrypt as scryptCallback, timingSafeEqual, type ScryptOptions } from "node:crypto";

function scrypt(password: string, salt: Buffer, keylen: number, options: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(password, salt, keylen, options, (error, derived) => {
      if (error) reject(error);
      else resolve(derived);
    });
  });
}

// The MVP plan stored `scrypt$salt$hash` at Node's default cost (N=16384).
// New hashes record N, r, and p. OWASP's scrypt parameters are N=2^17, r=8, p=1.
// Legacy three-part hashes still verify at the old cost.
const SCRYPT_N = 131072;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 32;
const SCRYPT_MAXMEM = 256 * 1024 * 1024;
const LEGACY_N = 16384;

type Params = { N: number; r: number; p: number };

function parseStored(stored: string): { params: Params; salt: Buffer; expected: Buffer } | null {
  const parts = stored.split("$");
  if (parts[0] !== "scrypt") return null;
  let n = Number.NaN;
  let r = Number.NaN;
  let p = Number.NaN;
  let saltHex = "";
  let hashHex = "";
  if (parts.length === 3) {
    n = LEGACY_N;
    r = SCRYPT_R;
    p = SCRYPT_P;
    saltHex = parts[1] ?? "";
    hashHex = parts[2] ?? "";
  } else if (parts.length === 6) {
    n = Number(parts[1]);
    r = Number(parts[2]);
    p = Number(parts[3]);
    saltHex = parts[4] ?? "";
    hashHex = parts[5] ?? "";
  } else {
    return null;
  }
  if (!Number.isInteger(n) || !Number.isInteger(r) || !Number.isInteger(p)) return null;
  if (n < 2 || n > SCRYPT_N || r < 1 || r > 32 || p < 1 || p > 16) return null;
  if (!/^[0-9a-f]+$/i.test(saltHex) || !/^[0-9a-f]+$/i.test(hashHex)) return null;
  if (saltHex.length < 16 || hashHex.length !== SCRYPT_KEYLEN * 2) return null;
  const salt = Buffer.from(saltHex, "hex");
  const expected = Buffer.from(hashHex, "hex");
  if (salt.length === 0 || expected.length !== SCRYPT_KEYLEN) return null;
  return { params: { N: n, r, p }, salt, expected };
}

export async function hashPassword(plain: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = (await scrypt(plain, salt, SCRYPT_KEYLEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: SCRYPT_MAXMEM,
  })) as Buffer;
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString("hex")}$${hash.toString("hex")}`;
}

export async function verifyPassword(plain: string, stored: string): Promise<boolean> {
  const parsed = parseStored(stored);
  if (!parsed) return false;
  let hash: Buffer;
  try {
    hash = (await scrypt(plain, parsed.salt, SCRYPT_KEYLEN, { ...parsed.params, maxmem: SCRYPT_MAXMEM })) as Buffer;
  } catch {
    return false;
  }
  if (hash.length !== parsed.expected.length) return false;
  return timingSafeEqual(hash, parsed.expected);
}

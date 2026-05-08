import { hash, verify } from "@node-rs/argon2";

const ARGON_OPTS = {
  // 2 = Argon2id; importing the const enum directly trips isolatedModules.
  algorithm: 2,
  memoryCost: 19 * 1024,
  timeCost: 2,
  parallelism: 1,
} as const;

export function hashPassword(plain: string): Promise<string> {
  return hash(plain, ARGON_OPTS);
}

export async function verifyPassword(plain: string, stored: string): Promise<boolean> {
  try {
    return await verify(stored, plain);
  } catch {
    return false;
  }
}

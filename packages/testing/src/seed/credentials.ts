import { randomBytes } from "node:crypto";
import { hash } from "@node-rs/argon2";
import type { DemoInstance, SeedAccountKey } from "./instance.ts";

// A password for each seeded account, made when the seed runs, printed once and stored only as the argon2id hash the
// server verifies with the same library and parameters. It is valid in the one database that was seeded.

export interface SeedCredentials {
  readonly passwords: Readonly<Record<SeedAccountKey, string>>;
  readonly hashes: Readonly<Record<SeedAccountKey, string>>;
}

export async function createCredentials(instance: DemoInstance): Promise<SeedCredentials> {
  const passwords: Record<string, string> = {};
  const hashes: Record<string, string> = {};
  for (const account of instance.accounts) {
    const password = randomBytes(18).toString("base64url");
    passwords[account.key] = password;
    hashes[account.key] = await hash(password);
  }
  return { passwords, hashes } as SeedCredentials;
}

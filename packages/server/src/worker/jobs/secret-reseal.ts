import type { MfaResealStore } from "@slugbase/db";
import { z } from "zod";
import { mfaSecretOptions } from "../../auth/mfa.ts";
import { defineJob } from "../job.ts";

// `secrets.reseal` (doc 01 sections 8.1 and 10, doc 05 section 3.3): re-seals every second-factor secret (`accounts.mfa_secret`) that is
// still under a secret-box key other than the current one, so that `ENCRYPTION_KEY_PREVIOUS` can be removed once none is left. The
// secret box keeps the previous keys only to open values sealed before a rotation; a member who does not sign in again would otherwise keep a
// secret under the old key for good.
//
// A run reads the key ids that hold secrets, keeps those the secret box says need rotation, and pages through the secrets under each in
// account id order. Each secret is re-sealed under the current key with the data that binds it to its account (`mfaSecretOptions`) and
// written with a compare-and-set on the ciphertext it read, so:
//   - a secret that changed meanwhile (the member signed in and the lazy re-sealing ran, re-enrolled or turned MFA off) is not
//     overwritten and counts as `skipped`;
//   - a secret that does not open (its key is no longer configured, or the data does not match) is left as it is, counts as
//     `unopenable` and is logged with its account id; a retry cannot fix it, so it never fails the run;
//   - every row is either the old ciphertext or the new one, never a half-written one, so a run that stops halfway leaves the rest
//     for the next, and a second run over finished work changes nothing.
// Disabled accounts and pending enrolments are included: an instance admin can enable an account again, and a secret left under a
// dropped key would then be lost. The job never holds a plaintext past the secret box's own call, and no line it logs carries a secret, a
// ciphertext or an error message, only counts, account ids, key ids and the name of an error class. A failing database rejects the
// run, which is retried. At most `SECRET_RESEAL_MAX_BATCHES` pages are read in one run, so a run is bounded; the next one continues.

export const SECRET_RESEAL_JOB = "secrets.reseal";

/** How many secrets one read takes, and at most how many reads one run makes across all key ids. */
const SECRET_RESEAL_BATCH = 100;
const SECRET_RESEAL_MAX_BATCHES = 50;

export interface SecretResealCounts {
  resealed: number;
  skipped: number;
  unopenable: number;
}

export function secretResealJob(store: Pick<MfaResealStore, "keyIds" | "secretsUnderKey" | "reseal">) {
  return defineJob({
    name: SECRET_RESEAL_JOB,
    payload: z.object({}),
    handle: async (_payload, context) => {
      const { secretBox } = context.adapters;
      if (!secretBox.available) {
        context.logger.info("Secret reseal skipped: no secret box is configured");
        return;
      }
      const counts: SecretResealCounts = { resealed: 0, skipped: 0, unopenable: 0 };
      let batches = 0;
      for (const { keyId } of await store.keyIds()) {
        if (!(await secretBox.needsRotation(keyId))) {
          continue;
        }
        let after: string | null = null;
        while (batches < SECRET_RESEAL_MAX_BATCHES) {
          const page = await store.secretsUnderKey(keyId, after, SECRET_RESEAL_BATCH);
          batches += 1;
          for (const { accountId, secret } of page) {
            const options = mfaSecretOptions(accountId);
            let replacement;
            try {
              replacement = await secretBox.reseal({ ciphertext: secret, keyId }, options);
            } catch (error) {
              counts.unopenable += 1;
              context.logger.warn("A secret could not be re-sealed and was left as it is", { accountId, error: error instanceof Error ? error.name : "unknown" });
              continue;
            }
            if (await store.reseal(accountId, secret, replacement)) {
              counts.resealed += 1;
            } else {
              counts.skipped += 1;
            }
          }
          const last = page[page.length - 1];
          if (page.length < SECRET_RESEAL_BATCH || last === undefined) {
            break;
          }
          after = last.accountId;
        }
      }
      const remaining: Record<string, number> = {};
      for (const { keyId, secrets } of await store.keyIds()) {
        if (await secretBox.needsRotation(keyId)) {
          remaining[keyId] = secrets;
        }
      }
      context.logger.info("Secret reseal finished", { ...counts, remaining });
    },
  });
}

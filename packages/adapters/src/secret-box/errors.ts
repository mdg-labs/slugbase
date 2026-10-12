export type SecretBoxOperation = "configure" | "seal" | "open";

/**
 * The only error the secret box throws. Its message names the operation and
 * nothing else: never a plaintext, a key, a key id, additional data or a
 * ciphertext, and no cause is attached (T7).
 */
export class SecretBoxError extends Error {
  readonly operation: SecretBoxOperation;

  constructor(operation: SecretBoxOperation) {
    super(`The secret box could not ${operation === "configure" ? "be configured" : operation}`);
    this.name = "SecretBoxError";
    this.operation = operation;
  }
}

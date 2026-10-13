/** Every form of a connection URL that must not appear in a message: the URL, its normalised form and the password, raw and decoded. */
export function connectionSecrets(url: string): readonly string[] {
  const secrets = new Set<string>([url]);
  try {
    const parsed = new URL(url);
    secrets.add(parsed.href);
    if (parsed.password !== "") {
      secrets.add(parsed.password);
      try {
        secrets.add(decodeURIComponent(parsed.password));
      } catch {
        // An undecodable password has no other form to redact.
      }
    }
  } catch {
    // A URL that does not parse is redacted as written.
  }
  return [...secrets].sort((a, b) => b.length - a.length);
}

export function redact(text: string, secrets: readonly string[]): string {
  let result = text;
  for (const secret of secrets) {
    result = result.split(secret).join("***");
  }
  return result;
}

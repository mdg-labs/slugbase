/** Edition-specific env defaults (spec §15). Single source of truth for #479–#483. */

export const SLUGBASE_EDITION = {
  CE: "ce",
  CLOUD: "cloud",
} as const;

export type SlugbaseEdition = (typeof SLUGBASE_EDITION)[keyof typeof SLUGBASE_EDITION];

const SLUGBASE_EDITION_SET = new Set<string>(Object.values(SLUGBASE_EDITION));

export const EDITION_PRESET_KEYS = [
  "PUBLIC_REGISTRATION",
  "EMAIL_VERIFICATION_REQUIRED",
  "SERVE_WEB_CLIENT",
  "VITE_BILLING_ENABLED",
  "VITE_MAIL_ADMIN_UI",
  "VITE_OIDC_ADMIN_UI",
  "VITE_AI_BYO_CREDENTIAL",
] as const;

export type EditionPresetKey = (typeof EDITION_PRESET_KEYS)[number];

type EditionPresetMap = Record<EditionPresetKey, string>;

const CLOUD_PRESETS: EditionPresetMap = {
  PUBLIC_REGISTRATION: "true",
  EMAIL_VERIFICATION_REQUIRED: "true",
  SERVE_WEB_CLIENT: "false",
  VITE_BILLING_ENABLED: "true",
  VITE_MAIL_ADMIN_UI: "false",
  VITE_OIDC_ADMIN_UI: "false",
  VITE_AI_BYO_CREDENTIAL: "false",
};

const CE_PRESETS: EditionPresetMap = {
  PUBLIC_REGISTRATION: "false",
  EMAIL_VERIFICATION_REQUIRED: "false",
  SERVE_WEB_CLIENT: "true",
  VITE_BILLING_ENABLED: "false",
  VITE_MAIL_ADMIN_UI: "false",
  VITE_OIDC_ADMIN_UI: "false",
  VITE_AI_BYO_CREDENTIAL: "false",
};

export class SlugbaseEditionParseError extends Error {
  constructor(raw: string | undefined) {
    super(
      `Invalid SLUGBASE_EDITION${raw === undefined || raw === "" ? "" : ` "${raw}"`}: expected "ce" or "cloud"`,
    );
    this.name = "SlugbaseEditionParseError";
  }
}

export class EditionPresetConflictError extends Error {
  readonly conflicts: EditionPresetConflict[];

  constructor(conflicts: EditionPresetConflict[]) {
    const keys = conflicts.map((c) => c.key).join(", ");
    super(
      `SLUGBASE_EDITION preset conflict in production for: ${keys}. Explicit env values disagree with edition defaults.`,
    );
    this.name = "EditionPresetConflictError";
    this.conflicts = conflicts;
  }
}

export type EditionPresetConflict = {
  key: EditionPresetKey;
  explicit: string;
  preset: string;
};

export type ResolveEnvWithEditionOptions = {
  /** Defaults to `rawEnv.NODE_ENV`. */
  nodeEnv?: string;
  /** Defaults to `rawEnv.SLUGBASE_EDITION`. */
  editionRaw?: string;
  /** Called for non-production conflicts; defaults to stderr output. */
  onWarn?: (message: string) => void;
};

export type ResolvedEnv = {
  env: Record<string, string>;
  edition: SlugbaseEdition;
  conflicts: EditionPresetConflict[];
  warnings: string[];
};

function isEnvUnset(value: string | undefined): boolean {
  return value === undefined || value.trim() === "";
}

/** Normalizes env-style booleans for conflict comparison. */
function normalizeEnvBoolean(value: string): boolean | undefined {
  const normalized = value.trim().toLowerCase();
  if (normalized === "true" || normalized === "1") return true;
  if (normalized === "false" || normalized === "0") return false;
  return undefined;
}

function envValuesConflict(explicit: string, preset: string): boolean {
  const explicitBool = normalizeEnvBoolean(explicit);
  const presetBool = normalizeEnvBoolean(preset);
  if (explicitBool !== undefined && presetBool !== undefined) {
    return explicitBool !== presetBool;
  }
  return explicit.trim() !== preset.trim();
}

/** Parses `SLUGBASE_EDITION`; rejects aliases and non-lowercase variants in v1. */
export function parseSlugbaseEdition(raw: string | undefined): SlugbaseEdition {
  if (raw === undefined || raw.trim() === "") {
    throw new SlugbaseEditionParseError(raw);
  }
  const trimmed = raw.trim();
  if (SLUGBASE_EDITION_SET.has(trimmed)) {
    return trimmed as SlugbaseEdition;
  }
  throw new SlugbaseEditionParseError(raw);
}

/** Returns edition-specific preset defaults as string env values. */
export function getEditionPresets(edition: SlugbaseEdition): EditionPresetMap {
  return edition === SLUGBASE_EDITION.CLOUD
    ? { ...CLOUD_PRESETS }
    : { ...CE_PRESETS };
}

function formatConflictWarning(conflict: EditionPresetConflict, edition: SlugbaseEdition): string {
  return `[slugbase] SLUGBASE_EDITION=${edition}: ${conflict.key}="${conflict.explicit}" conflicts with edition preset "${conflict.preset}"`;
}

function defaultWarn(message: string): void {
  process.stderr.write(`${message}\n`);
}

/**
 * Applies edition presets for unset keys and detects conflicts when explicit values
 * disagree with the active edition default.
 */
export function resolveEnvWithEdition(
  rawEnv: Record<string, string | undefined>,
  options: ResolveEnvWithEditionOptions = {},
): ResolvedEnv {
  const editionRaw = options.editionRaw ?? rawEnv.SLUGBASE_EDITION;
  const edition = parseSlugbaseEdition(editionRaw);
  const presets = getEditionPresets(edition);
  const nodeEnv = (options.nodeEnv ?? rawEnv.NODE_ENV ?? "").trim().toLowerCase();
  const isProduction = nodeEnv === "production";

  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(rawEnv)) {
    if (value !== undefined && !isEnvUnset(value)) {
      env[key] = value;
    }
  }

  env.SLUGBASE_EDITION = edition;

  const conflicts: EditionPresetConflict[] = [];
  for (const key of EDITION_PRESET_KEYS) {
    const preset = presets[key];
    const explicit = rawEnv[key];
    if (isEnvUnset(explicit)) {
      env[key] = preset;
      continue;
    }
    const explicitValue = explicit as string;
    if (envValuesConflict(explicitValue, preset)) {
      conflicts.push({ key, explicit: explicitValue, preset });
    }
    env[key] = explicitValue;
  }

  const warnings: string[] = [];
  if (conflicts.length > 0) {
    if (isProduction) {
      throw new EditionPresetConflictError(conflicts);
    }
    const warn = options.onWarn ?? defaultWarn;
    for (const conflict of conflicts) {
      const message = formatConflictWarning(conflict, edition);
      warnings.push(message);
      warn(message);
    }
  }

  return { env, edition, conflicts, warnings };
}

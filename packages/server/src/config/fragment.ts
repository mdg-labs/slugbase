import { z } from "zod";

/** The environment a process starts with. */
export type EnvironmentVariables = Readonly<Record<string, string | undefined>>;

/** One problem found in the configuration: the key and what is wrong with it. Never a value. */
export interface ConfigIssue {
  readonly key: string;
  readonly message: string;
}

/** What a fragment's `refine` sees besides the parsed values. */
export interface RefineContext {
  /** `NODE_ENV` is `production`: the refusals of doc 01 section 11 apply. */
  readonly production: boolean;
  /** Report a problem with a key. The message must not contain the key's value. */
  issue(key: string, message: string): void;
  /** Report a setting that is allowed but probably unintended; it goes to the startup log. The message must not contain the key's value. */
  warn(key: string, message: string): void;
}

/**
 * A group of related keys. A module declares its keys as a fragment and the
 * process schemas compose the fragments they need, so Cloud modules extend a
 * process schema with their own fragments instead of editing it.
 */
export interface EnvFragment<Shape extends z.ZodRawShape = z.ZodRawShape, Collected extends object = object> {
  readonly shape: Shape;
  /** Development values of `.env.example` that production refuses (doc 01 section 11). */
  readonly developmentDefaults?: Readonly<Record<string, string>>;
  /** Checks across keys and the production refusals, run once the keys parsed. */
  refine?(values: z.infer<z.ZodObject<Shape>>, context: RefineContext): void;
  /**
   * Keys whose names carry a part the operator chooses (`OIDC_<SLUG>_*`) cannot be listed in `shape`. This reads
   * them from the whole environment, reports problems through the context and returns the members they add to the
   * configuration. It runs whether or not the keys of `shape` parsed, so one start reports every problem.
   */
  collect?(env: EnvironmentVariables, context: RefineContext): Collected;
}

export function envFragment<Shape extends z.ZodRawShape, Collected extends object = object>(
  fragment: EnvFragment<Shape, Collected>,
): EnvFragment<Shape, Collected> {
  return fragment;
}

/**
 * The adapter rule of doc 01 section 11: a partial set of an adapter's keys
 * refuses to start. Reports every key of the set that is missing when at least
 * one of them is set.
 */
export function requireAllOrNone(
  keys: readonly string[],
  values: Readonly<Record<string, unknown>>,
  context: RefineContext,
): void {
  const isSet = (key: string): boolean => values[key] !== undefined;
  if (!keys.some(isSet)) {
    return;
  }
  for (const key of keys.filter((candidate) => !isSet(candidate))) {
    context.issue(key, `is required because ${keys.filter(isSet).join(", ")} ${keys.filter(isSet).length === 1 ? "is" : "are"} set`);
  }
}

export type IntersectUnion<Union> = (Union extends unknown ? (value: Union) => void : never) extends (value: infer Both) => void
  ? Both
  : never;

export type MergedShape<Fragments extends readonly EnvFragment[]> =
  IntersectUnion<Fragments[number]["shape"]> extends infer Shape extends z.ZodRawShape ? Shape : never;

/** The members the `collect` functions of the fragments add to the configuration. */
export type CollectedOf<Fragments extends readonly EnvFragment[]> =
  IntersectUnion<
    Fragments[number] extends infer Fragment
      ? Fragment extends EnvFragment<z.ZodRawShape, infer Collected>
        ? Collected
        : never
      : never
  > extends infer Both extends object
    ? Both
    : object;

export interface EnvSchema<Shape extends z.ZodRawShape = z.ZodRawShape, Collected extends object = object> {
  readonly object: z.ZodObject<Shape>;
  /** The phantom of the members `collectors` add; never set. */
  readonly collected?: Collected;
  readonly collectors: readonly ((env: EnvironmentVariables, context: RefineContext) => object)[];
  /** Every key the schema declares. */
  readonly keys: readonly string[];
  readonly developmentDefaults: Readonly<Record<string, string>>;
  readonly refinements: readonly ((values: Readonly<Record<string, unknown>>, context: RefineContext) => void)[];
}

/** Composes fragments into one process schema. Two fragments declaring one key is a programming error. */
export function composeEnvSchema<const Fragments extends readonly EnvFragment[]>(
  fragments: Fragments,
): EnvSchema<MergedShape<Fragments>, CollectedOf<Fragments>> {
  const shape: Record<string, z.core.$ZodType> = {};
  const developmentDefaults: Record<string, string> = {};
  for (const fragment of fragments) {
    for (const [key, field] of Object.entries(fragment.shape)) {
      if (key in shape) {
        throw new Error(`Environment key ${key} is declared by two fragments`);
      }
      shape[key] = field;
    }
    Object.assign(developmentDefaults, fragment.developmentDefaults);
  }
  return {
    object: z.object(shape) as unknown as z.ZodObject<MergedShape<Fragments>>,
    collectors: fragments.flatMap((fragment) =>
      fragment.collect === undefined
        ? []
        : [(env: EnvironmentVariables, context: RefineContext) => fragment.collect?.(env, context) ?? {}],
    ),
    keys: Object.keys(shape),
    developmentDefaults,
    refinements: fragments.flatMap((fragment) =>
      fragment.refine === undefined
        ? []
        : [(values: Readonly<Record<string, unknown>>, context: RefineContext) => {
            fragment.refine?.(values, context);
          }],
    ),
  };
}

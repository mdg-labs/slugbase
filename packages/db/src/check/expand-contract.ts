import { analyseSql, createdTableOf, functionArityKey, functionStatementOf, identifierForm, mentionOfAny, setsSessionTimeout, SYSTEM_ROLE, TENANT_FUNCTIONS, type AnalysedStatement, type ColumnType, type CreatedTable, type FunctionIdentity, type FunctionStatement, type Operation, type TableName, type TriggerForm } from "./migration-statements.ts";
import { readJournal, readMigration } from "./migration-files.ts";
import { customStep, functionPrivilegeStatements, privilegeStatements, readReleasedPrivileges, readReleasedStep, readReleaseState, releaseTags, sameFunctionPrivileges, sameTablePrivileges, statementForm, type FunctionPrivilege, type PrivilegeStatement, type ReleaseState } from "./release-history.ts";
import type { CheckRule, Finding } from "./types.ts";

// Doc 05 section 5.2 and Q52: several replicas run during a rolling deploy, so a
// migration must work for the code before it and after it. Every migration
// added since the latest release tag is read, and the rule rejects in it:
//
//   - dropping or renaming a table or column that exists at that tag (also
//     moving a table to another schema, or dropping a schema that holds one),
//   - adding a NOT NULL column without a default to a table that exists at it,
//   - adding a column that rewrites such a table under an ACCESS EXCLUSIVE lock,
//     which writes every existing row: a serial type (serial, smallserial,
//     bigserial, serial2/4/8), an identity column (GENERATED ALWAYS|BY DEFAULT
//     AS IDENTITY) or a generated column that is not marked VIRTUAL (PostgreSQL
//     17 has stored ones only, so GENERATED ALWAYS AS (...) counts as stored
//     unless VIRTUAL follows); a nullable column or one with a constant or
//     stable DEFAULT, such as now(), does not rewrite and is accepted, unless
//     its type is a domain with a CHECK or NOT NULL constraint, which validates
//     every existing row (also with a DEFAULT), or a domain whose default is not
//     a constant or a call accepted as stable (random(), say), which gives each
//     existing row its own value, unless the column states a default of its own.
//     A domain over a domain takes the default of its base when it is created,
//     and its own DEFAULT (NULL included) or a later SET/DROP DEFAULT replaces
//     it. The domains come from every
//     CREATE DOMAIN of the migration chain, the migrations of the release
//     included; a built-in type, an array type, an enum and a domain without
//     constraints are accepted, and so is no other type: a name this check
//     cannot show to be one of those (a type of another schema, a type no
//     migration declares, a domain an ALTER DOMAIN touched) is rejected. After
//     a migration this check cannot read, or a statement it cannot place (a DO
//     block, say), shipped or added, marked or not, the types declared before
//     it count as unproven too (the citext type excepted), since it may have
//     given a domain a constraint or a default, or replaced an enum with one. A
//     CREATE DOMAIN, an ALTER TYPE that renames or moves nothing, and an ALTER
//     DOMAIN action that adds no constraint are read and do not count,
//   - changing the type of a column of such a table (any change: whether it
//     rewrites the table depends on the old and the new type, which a lint of
//     the file cannot tell),
//   - setting a column of such a table NOT NULL (SET NOT NULL, or a NOT NULL
//     table constraint), or dropping its default (DROP DEFAULT, or SET DEFAULT
//     NULL, which removes it): the previous release can still write rows that
//     rely on either,
//   - creating an index on such a table without CONCURRENTLY, which includes
//     adding a PRIMARY KEY, UNIQUE or EXCLUDE constraint, also as the inline
//     constraint of an added column; only UNIQUE USING INDEX attaches an index
//     safely, PRIMARY KEY USING INDEX is rejected because it sets the index's
//     columns NOT NULL where they are not already,
//   - adding a CHECK or FOREIGN KEY constraint to such a table without NOT VALID
//     (it is validated with VALIDATE CONSTRAINT in a later step), which includes
//     an inline CHECK on an added column and an inline REFERENCES on an added
//     column that has a default,
//   - revoking privileges (REVOKE ... FROM) on a table that exists at that tag,
//     or on an object that is not a named table (a schema, a sequence, a
//     database, ALL TABLES IN SCHEMA ...): a running replica may lose the access
//     it uses. A REVOKE on tables the release does not hold passes, and so does
//     a re-emitted one (below). The release state holds tables only, so a view
//     or sequence of the release named as a bare table is not seen,
//   - replacing a function the chain declares (CREATE OR REPLACE FUNCTION) with a
//     different return type, or where an earlier statement this check could not
//     read may have created it, so that it cannot show the signature and return
//     type stay as they were,
//   - DROP FUNCTION [IF EXISTS] f(args), and a REVOKE on one function other than the system-function form
//     below, unless an earlier migration already ran the same statement (below),
//   - any statement this check does not positively read as one of the forms it
//     lists as safe (CREATE TABLE of a column list and nothing after it,
//     CREATE INDEX/POLICY/EXTENSION/SEQUENCE/SCHEMA, an enum CREATE TYPE, the
//     system-function forms below, ALTER TABLE actions, DROP INDEX/POLICY, GRANT
//     and COMMENT of a whole shape),
//     or that calls a function outside a short list of built-ins and the
//     tenant context functions. Everything else (DO, CALL, COPY, SELECT, SET,
//     other ALTER/DROP/CREATE forms, ...) could hold any of the above.
//
// The system-function forms of doc 05 section 3.3 are the statements that add a
// system operation, and an unmarked migration may use them:
//
//   - CREATE FUNCTION, or CREATE OR REPLACE FUNCTION of a function with the
//     signature and return type the chain declares, or of one it does not declare
//     (where it has read every earlier statement), in any language and with or
//     without SECURITY DEFINER. The body is a string that runs only when the
//     function is called, so it is not analysed as migration statements; the
//     system-operations rule reads the function in the database. A migration can
//     call a function the chain declares in a default, a policy, an index
//     expression or predicate, and also without a parenthesis (field-selection
//     notation: "(t).f" is "f(t)" for a row type t), and its body would then run
//     in the migration. So a statement that mentions the name of such a function
//     as a word or a quoted identifier is rejected (also a column named like
//     it); only the statements that declare, hand over or grant on it name it.
//     Names are compared on the text as written, as PostgreSQL compares them:
//     only the letters A to Z folded to lower case (no Unicode case mapping), a
//     quoted name read as the unquoted one, and both cut to 63 bytes at a
//     character boundary, qualified or not. A CREATE FUNCTION whose name, quoted
//     or not, has a character outside printable ASCII is not read, so every name
//     the check holds is ASCII; nor is one whose name is
//     longer than 63 bytes, which PostgreSQL stores under a shorter name. Nor is one that can be called with a single argument of a type that
//     is not a built-in (a first input argument of such a type whose later input
//     arguments all have a default, or a VARIADIC one), since field-selection
//     notation can call it. Names are held to more: a function named like
//     a built-in this check lets a migration call, or like a word it reads as
//     grammar before a "(", is not read, and a tenant context function stays one
//     LANGUAGE sql SELECT of built-ins, since every policy relies on it,
//   - CREATE [OR REPLACE] TRIGGER name BEFORE UPDATE ON table FOR EACH ROW EXECUTE
//     FUNCTION f(), and CREATE CONSTRAINT TRIGGER name AFTER DELETE OR
//     UPDATE ON table DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION f(),
//     for an f that an earlier statement of the chain declares without
//     arguments as RETURNS trigger. A trigger function runs when a row is written (or,
//     for the deferred form, when the transaction that wrote it commits), not
//     when the trigger is created, and a migration writes no row (a data change is
//     rejected below), so the statement names f without calling it. Any other trigger
//     (another timing or event, a column list, a WHEN condition, arguments, a
//     constraint trigger of another shape, an event trigger) is not read. A constraint
//     trigger has no OR REPLACE, so a file that creates it again drops it first: DROP
//     TRIGGER [IF EXISTS] name ON table is accepted when the same file creates the trigger
//     of that name and table again with the function and the form it had (a trigger of the release that
//     is dropped and not created again, or created with another function or the other form, is reported),
//     and not after a statement this check cannot read, which may have changed the trigger. OR REPLACE replaces a trigger
//     of that name on that table whatever its shape, so it is accepted only over the
//     trigger the chain created with the same f in the same form (the statement again), or where this
//     check has read every earlier statement, and so can show the name is no trigger of
//     the release: after a migration or statement it cannot read, or a table move
//     (RENAME TO, SET SCHEMA), it is rejected, as is a replacement that gives the
//     trigger another f or the other form. The trigger is identified by its name and its table, and the
//     name, the schema and the table name are each compared as PostgreSQL does (an
//     unquoted name folded to lower case, a quoted one kept, each cut to 63 bytes), and
//     an OR REPLACE with a trigger or table name outside printable ASCII is not read,
//   - ALTER FUNCTION f(args) OWNER TO slugbase_system, for a function the same
//     file creates; any other action or owner is not read,
//   - REVOKE ALL ON FUNCTION f(args) FROM PUBLIC, for a function the same file
//     creates, and GRANT EXECUTE ON FUNCTION f(args) TO slugbase_app; any other
//     privilege, role or form is not read,
//   - GRANT CREATE ON SCHEMA s TO slugbase_system together with the REVOKE CREATE
//     ON SCHEMA s FROM slugbase_system that takes it back in the same file, with
//     nothing but the two function statements above (CREATE FUNCTION and ALTER
//     FUNCTION ... OWNER TO) between them. A schema CREATE grant to another role
//     or in another shape, or one that the file does not revoke, is rejected.
//
// A function is identified by its schema, its name and the types of its input
// arguments as written (names, modes and defaults left out), so a signature
// spelled differently in two statements is not recognised as one function and
// the later statement is rejected rather than guessed at.
//
// A re-emitted REVOKE is the one exception to the REVOKE rule above. Every migration that
// changes src/sql/ carries all of it again as a custom step (doc 05 section 5.1), so the
// REVOKE ... ON TABLE statements of the release come back in each later step. What a REVOKE
// does depends on the GRANTs on the same table around it, so a REVOKE on named tables is
// accepted only when it stands in the migration's own custom step (the statements from the
// `-- slugbase:custom-sql` marker to the end of the file) and, for each table it names, the
// GRANT and REVOKE statements on that table in that step (with those on a wider object: a
// schema, ALL TABLES IN SCHEMA) are the same, in the same order, as in the latest custom step
// of the release, read from git at the tag as release-history.ts reads the journal. The
// statements are compared as the reader gives them, comments removed and runs of whitespace
// collapsed to one space; letter case, privileges, roles, the order of tables and the quoting
// of names stay as written. A REVOKE that stands outside the custom step, or on a table whose
// GRANTs or REVOKEs differ from the release's (a GRANT dropped, moved before the REVOKE or
// added), leaves the table other privileges than the release did and is judged as above. A
// REVOKE on a schema, a sequence, a database or ALL TABLES IN SCHEMA is never accepted this
// way, nor is any other statement a re-emit repeats: they are judged as above. Where the
// release has no custom step, or either step holds a GRANT or REVOKE the reader does not
// place, no statement counts as already applied.
//
// A re-emitted function statement is the other exception. A contract migration that drops a function
// keeps its DROP FUNCTION IF EXISTS in a src/sql/ file (and one that takes a role's access to a function
// away keeps its REVOKE ... ON FUNCTION ... FROM there), so every later custom step carries the statement
// again. The reader places a DROP FUNCTION [IF EXISTS] of one function with an argument list, no CASCADE
// and a name of printable ASCII within 63 bytes, and a REVOKE on one such function without CASCADE, as
// statements of that shape (migration-statements.ts, `FunctionStatement`); anything else of either kind stays
// a statement it cannot place. Such a statement is accepted without a header only when it stands in the
// migration's own custom step and an earlier migration of the journal, a shipped one or one added since the
// release, ran the identical statement (compared as the REVOKE statements above are: comments removed, whitespace
// runs collapsed, everything else as written) in its custom step while carrying a valid contract header, so
// the statement is the contract half of a pair that already shipped or is already checked. An earlier
// migration without a valid header licenses nothing. The licence ends where the chain may have undone the
// statement: at a migration or statement this check cannot read, and, for a drop, at a CREATE FUNCTION of a
// function with the same schema, name and number of arguments (the eight-argument function a migration
// dropped does not end it when the nine-argument function of the same name is declared). A re-emitted REVOKE
// on a function also needs the migration's custom step to leave the function the GRANT and REVOKE
// statements on it (and on any wider object) that the latest custom step before it left it, in the same
// order, so a later GRANT of the function in src/sql/ is not undone unseen. A drop or a REVOKE of the same
// shape that no earlier migration with a valid header ran is judged as above, and needs the header.
//
// How such a statement counts for the statements after it: a DROP FUNCTION without CASCADE fails when a
// trigger, a column or index default or a policy depends on the function, and a REVOKE on a function touches
// no object a statement of this check reads, so neither can create, replace, rename or remove a trigger or
// change a type, whether it is accepted or not. They do not make the statements after them unreadable: the
// trigger and type checks go on to judge those statements on their own, as they would without the drop. The
// dropped function leaves the model of functions and trigger functions the chain declares. A statement the
// reader cannot place (a CASCADE drop, say) still does.
//
// Everything else the rules above reject is accepted only in the contract half of an
// expand/contract pair, and only with a header in the leading comment block of the file,
//     -- slugbase:contract expand=<migration tag> release=<version>
// where <migration tag> is a migration of the journal that the release <version> already
// contained, and <version> is a release tag. The expand migration has therefore shipped in a
// release before the one that carries this file (Q52). The header alone decides: a valid one
// accepts the step on every event, a missing or invalid one fails it. The maintainer approves
// the step by merging the pull request that carries it, so no label or environment value is
// read.
//
// A file that sets lock_timeout or statement_timeout is rejected whatever its
// header says: `migrate` sets both for its session (5 s and 15 min, and
// lock_timeout off for a CONCURRENTLY step), and a migration changes neither.
//
// A data-changing statement is rejected the same way, whatever the header says, and
// without an exception for a table the migration creates (D25: migrations stay fast and
// schema-only; a backfill is a worker job).
// Those are INSERT (also INSERT ... SELECT), UPDATE, DELETE, TRUNCATE, MERGE and
// COPY ... FROM, as the statement itself or where the reader can see it nested
// (a CTE, the query of a CREATE TABLE ... AS or of a COPY). One inside a string
// body (DO, a function) is not seen and stays a statement it cannot place.
//
// The tables and columns "at the tag" come from the snapshot of the tag's last
// migration and from the custom SQL of the release. The snapshot holds the tables of
// the Drizzle schema, so a table that only custom SQL can create (an UNLOGGED one,
// say) is read from the latest custom step of the release, as release-history.ts
// reads the journal: every CREATE [UNLOGGED] TABLE [IF NOT EXISTS] of it, with the
// columns of its list and the columns its ALTER TABLE statements add, drop or rename.
// Such a table is judged by every rule above as a table of the snapshot is, and the
// re-emitted REVOKE exception applies to it the same way. The re-emit of its CREATE TABLE
// is accepted while its column list is the one the release created the table with:
// CREATE TABLE IF NOT EXISTS leaves an existing table as it is, so another list would
// never reach a database that has the table, and is reported (a column is added or
// dropped with ALTER TABLE instead). The release must be readable for that: a custom
// step that creates a table whose columns the reader cannot name (a LIKE clause, CREATE
// TABLE ... AS) makes the rule fail. Views, sequences and other objects that custom SQL
// creates (functions and policies as well) are not part of the release state.
// Without a release tag in a full clone every object counts as unreleased. Without a way
// to tell (a shallow clone, no git) the rule fails; see release-history.ts.

const ID = "expand-contract";
const CITEXT = "public.citext";
const HEADER_PREFIX = "-- slugbase:contract";
const HEADER = /^-- slugbase:contract expand=(\S+) release=(\S+)\s*$/;
const HEADER_SYNTAX = `${HEADER_PREFIX} expand=<migration tag> release=<version>`;

const key = (table: TableName): string => `${table.schema}.${table.name}`;
const functionKey = ({ name, args }: FunctionIdentity): string => `${key(name)}(${args})`;
const functionLabel = ({ name, args }: FunctionIdentity): string => `${describe(name)}(${args})`;

const FORM_LABELS: Record<TriggerForm, string> = {
  plain: "a BEFORE UPDATE row trigger",
  constraint: "a deferred constraint trigger AFTER DELETE OR UPDATE",
};

/** A trigger as the chain created it: the function it executes and the form it fires in. */
interface TriggerDefinition {
  readonly fn: FunctionIdentity;
  readonly form: TriggerForm;
}

/** What a trigger made again changes about the trigger it replaces, as the problem says it, or nothing when it is the same function in the same form. */
function triggerChange(name: string, table: TableName, before: TriggerDefinition, after: TriggerDefinition): string[] {
  const subject = `replaces trigger ${name} on ${describe(table)}`;
  if (functionKey(before.fn) !== functionKey(after.fn)) {
    return [`${subject}, which executes ${functionLabel(before.fn)} now, with one that executes ${functionLabel(after.fn)}: the previous release still relies on the trigger as it is`];
  }
  if (before.form !== after.form) {
    return [`${subject}, which is ${FORM_LABELS[before.form]} now, with ${FORM_LABELS[after.form]}: it fires at another time or for other events, and the previous release still relies on the trigger as it is`];
  }
  return [];
}

// A trigger is identified by its table and its name, which the reader gives as PostgreSQL compares it. The two parts cannot run together:
// a NUL does not occur in a name.
const triggerKey = (table: TableName, name: string): string => `${key(table)}\0${name}`;

// While a file holds CREATE on a schema for slugbase_system, only the statements that create a function and
// hand it over run; a statement this check cannot place or a data change is reported on its own.
const FUNCTION_STATEMENTS = new Set<Operation["kind"]>(["declares-function", "alters-function-owner", "revokes-schema-create", "unknown", "data-change"]);

function describe(table: TableName): string {
  return table.schema === "public" ? table.name : key(table);
}

interface TypeState {
  constraints: boolean;
  volatileDefault: boolean;
}

const UNPROVEN: TypeState = { constraints: true, volatileDefault: true };

/** The tables and columns of the release, which the added migrations change as they go. */
class Released {
  private readonly tables = new Map<string, Set<string>>();
  // The column list of the CREATE TABLE statement of each table the release's custom SQL creates (see `ReleasedTable.definition`), by table.
  private readonly definitions = new Map<string, string>();
  // The types the migration chain declares: constraints is true when the type is, or may be, a domain with
  // constraints, and volatileDefault when it has, or may have, a default that is not a constant or a stable call.
  // citext is the type of the extension this package installs (doc 05 section 1), which is no domain.
  private readonly types = new Map<string, TypeState>([[CITEXT, { constraints: false, volatileDefault: false }]]);

  // The return type of each function the migration chain declares, by name and input argument types. functionsKnown
  // is false after a migration or statement this check cannot read, which may have created or replaced a function.
  private readonly functions = new Map<string, string>();
  private functionsKnown = true;
  // The lower-case names of the functions the chain declares, whose body runs when a statement calls one.
  private readonly functionNames = new Set<string>();
  // The functions the chain declares without arguments as RETURNS trigger, by name and (empty) input argument types.
  private readonly triggerFunctions = new Set<string>();
  // The function and the form of each trigger the chain creates, by its table and name, since the last point where the chain may have changed a
  // trigger unseen. triggersKnown is false after a migration or statement this check cannot read, or one that moves a table, which may
  // have created, renamed, replaced or moved a trigger: the triggers held are then dropped, since an unseen statement may have given
  // one of them another shape or function.
  private readonly triggers = new Map<string, TriggerDefinition>();
  private triggersKnown = true;
  // What the migration being read has done: the functions it declares, and the schemas it has granted CREATE on to
  // slugbase_system and not yet revoked.
  private declared = new Set<string>();
  private creatable = new Set<string>();
  // The triggers the migration has dropped and not yet created again, by table and name, with the function and form each had when it was first
  // dropped (undefined when none was known to exist).
  private dropped = new Map<string, { readonly table: TableName; readonly name: string; readonly trigger: TriggerDefinition | undefined }>();
  // The DROP FUNCTION and function REVOKE statements that an earlier migration with a valid contract header ran in its custom step, by action,
  // function name and number of arguments (see `functionArityKey`), with the form of each statement (see `FunctionStatement`); forgotten when the chain may have undone them: at a statement or
  // migration this check cannot read, and for a drop where a function of that name and arity is declared again. pendingFunctionStatements holds those of the
  // migration being read, which count once the migration's header is shown valid.
  private ranFunctionStatements = new Map<string, Set<string>>();
  private pendingFunctionStatements = new Map<string, Set<string>>();

  readonly tag: string | undefined;

  constructor(tag: string | undefined, state: ReleaseState | undefined) {
    this.tag = tag;
    for (const table of state?.tables ?? []) {
      this.tables.set(key(table), new Set(table.columns));
      if (table.definition !== undefined) {
        this.definitions.set(key(table), table.definition);
      }
    }
  }

  /**
   * The problem of a CREATE TABLE statement of a table that the release's custom SQL created, when its column list is not the one the
   * release created the table with. The statement is the re-emit of src/sql/ (`CREATE TABLE IF NOT EXISTS` leaves a table that exists
   * as it is, and a CREATE TABLE without IF NOT EXISTS fails on it), so a changed column list never reaches a database that has the
   * table: the database and the source then disagree on the table. A column is added or dropped with ALTER TABLE, which the
   * rules above judge. A table the migration dropped or moved is not one of the release any more.
   */
  createProblem(created: CreatedTable): string[] {
    if (created.kind !== "read" || this.definitions.get(key(created.table)) === undefined || this.definitions.get(key(created.table)) === created.definition) {
      return [];
    }
    return [`creates table ${describe(created.table)} again with a column list other than the one the custom SQL of ${this.tag ?? "the latest release"} created it with: the table exists there, and the statement leaves an existing table as it is (or fails on it), so the change never reaches a database that has the table (add or drop a column with ALTER TABLE)`];
  }

  hasTable(table: TableName): boolean {
    return this.tables.has(key(table));
  }

  hasColumn(table: TableName, column: string): boolean {
    return this.tables.get(key(table))?.has(column) === true;
  }

  /**
   * A migration this check cannot read, or a statement in it that it cannot place (a DO block, say),
   * may have given any domain a constraint, renamed or moved a type, or replaced an enum with a domain:
   * no type declared before it stays one this check can show to be free of constraints. The type of the
   * extension this package installs is the exception, and a type a later migration declares is read as
   * it is declared. The same holds for the functions: one may have been created or replaced, and for the
   * triggers: one may have been created, renamed or dropped.
   */
  taint(): void {
    this.functionsKnown = false;
    this.ranFunctionStatements.clear();
    this.pendingFunctionStatements.clear();
    this.forgetTriggers();
    for (const name of this.types.keys()) {
      if (name !== CITEXT) {
        this.types.set(name, UNPROVEN);
      }
    }
  }

  private forgetTriggers(): void {
    this.triggersKnown = false;
    this.triggers.clear();
  }

  /** Starts reading a migration added since the release. */
  startFile(): void {
    this.declared = new Set();
    this.creatable = new Set();
    this.dropped = new Map();
    this.pendingFunctionStatements = new Map();
  }

  /** Whether an earlier migration with a valid contract header ran this statement, with nothing since that may have brought back what it removed. */
  ranBefore({ action, fn }: FunctionStatement, form: string): boolean {
    return this.ranFunctionStatements.get(`${action}\0${functionArityKey(fn)}`)?.has(form) === true;
  }

  /** Notes a DROP FUNCTION or function REVOKE of the migration being read, which counts as run once `commitFunctionStatements` says its header is valid. */
  noteFunctionStatement({ action, fn }: FunctionStatement, form: string): void {
    const key = `${action}\0${functionArityKey(fn)}`;
    this.pendingFunctionStatements.set(key, new Set([...(this.pendingFunctionStatements.get(key) ?? []), form]));
  }

  /** The migration read has a valid contract header: the statements it noted count as run by it. */
  commitFunctionStatements(): void {
    for (const [key, forms] of this.pendingFunctionStatements) {
      this.ranFunctionStatements.set(key, new Set([...(this.ranFunctionStatements.get(key) ?? []), ...forms]));
    }
    this.pendingFunctionStatements = new Map();
  }

  hasPendingFunctionStatements(): boolean {
    return this.pendingFunctionStatements.size > 0;
  }

  /**
   * What is still open when the migration ends: CREATE on a schema that was granted to slugbase_system and not revoked, and a
   * trigger of the release that was dropped and not created again.
   */
  endFile(): string[] {
    return [
      ...[...this.creatable].map((schema) => `grants CREATE on schema ${schema} to ${SYSTEM_ROLE} and does not revoke it in the same file: the role would keep the right to create objects in the schema`),
      ...[...this.dropped.values()]
        .flatMap(({ table, name, trigger }) => (trigger === undefined ? [] : [{ table, name, trigger }]))
        .map(({ table, name, trigger }) => `drops trigger ${name} on ${describe(table)}, which executes ${functionLabel(trigger.fn)} now, and does not create it again in the same file: the previous release still relies on the trigger`),
    ];
  }

  /** Takes the type or function a migration declares or changes into the model. */
  track(operation: Operation): void {
    if (operation.kind === "declares-function") {
      this.functions.set(functionKey(operation.fn), operation.returns);
      if (operation.fn.args === "" && operation.returns === "trigger") {
        this.triggerFunctions.add(functionKey(operation.fn));
      } else {
        this.triggerFunctions.delete(functionKey(operation.fn));
      }
      const name = operation.fn.name.name.toLowerCase();
      if (!TENANT_FUNCTIONS.has(name)) {
        this.functionNames.add(identifierForm(operation.fn.name.name));
      }
      // A function of this name exists again, so a DROP of it that an earlier migration ran would drop this one.
      this.ranFunctionStatements.delete(`drop\0${functionArityKey(operation.fn)}`);
      this.pendingFunctionStatements.delete(`drop\0${functionArityKey(operation.fn)}`);
    } else if (operation.kind === "creates-trigger") {
      this.triggers.set(triggerKey(operation.table, operation.name), { fn: operation.fn, form: operation.form });
    } else if (operation.kind === "drops-trigger") {
      this.triggers.delete(triggerKey(operation.table, operation.name));
    } else if (operation.kind === "rename-table" || operation.kind === "set-schema") {
      // The triggers of the table go with it, under a key the model does not move them to.
      this.forgetTriggers();
    } else if (operation.kind === "declares-type") {
      this.types.set(key(operation.name), {
        constraints: operation.ownConstraints || !this.constraintFree(operation.base),
        volatileDefault: operation.volatileDefault ?? this.volatileDefaultOf(operation.base),
      });
    } else if (operation.kind === "sets-default") {
      const state = this.types.get(key(operation.name));
      if (state !== undefined) {
        this.types.set(key(operation.name), { ...state, volatileDefault: operation.volatileDefault });
      }
    } else if (operation.kind === "retypes") {
      for (const name of operation.names) {
        this.types.set(key(name), UNPROVEN);
      }
    } else if (operation.kind === "unknown" && operation.function !== undefined) {
      // A DROP FUNCTION without CASCADE fails when a trigger, a default or an index depends on the function, so it removes no trigger and changes no
      // type (the statement is rejected on its own unless an earlier migration ran it): it taints nothing, and only the function itself leaves the model.
      if (operation.function.action === "drop") {
        this.functions.delete(functionKey(operation.function.fn));
        this.triggerFunctions.delete(functionKey(operation.function.fn));
      }
    } else if (operation.kind === "unknown" && operation.keepsTypes !== true) {
      // The statements marked keepsTypes (CREATE DOMAIN, ALTER DOMAIN and ALTER TYPE) name a type and no table, so they create,
      // rename and drop no trigger; every other statement this check cannot place may, and taints the triggers as the types.
      this.taint();
    }
  }

  /** Whether the type is one that adds no constraint to the values of its columns: not a domain with constraints, and not a name this check cannot place. */
  private constraintFree(type: ColumnType): boolean {
    switch (type.kind) {
      case "builtin":
        return true;
      case "unreadable":
        return false;
      case "named":
        return this.types.get(key(type.name))?.constraints === false;
    }
  }

  /** Whether the default a domain over the type takes from it is, or may be, one that is not a constant or a stable call. */
  private volatileDefaultOf(type: ColumnType): boolean {
    switch (type.kind) {
      case "builtin":
        return false;
      case "unreadable":
        return true;
      case "named":
        return this.types.get(key(type.name))?.volatileDefault !== false;
    }
  }

  /**
   * The problem of a statement that mentions a function the chain declares, which may call it and run its
   * body in the migration (also without a parenthesis: `(t).f` is `f(t)`), so any word of that name counts,
   * also a column or table named like it. A statement that declares, hands over or grants on a function
   * names it without calling it, and one the reader cannot place is reported by the reader already.
   */
  callProblem(statement: AnalysedStatement): string[] {
    const names = statement.operations.some((operation) => operation.kind === "declares-function" || operation.kind === "alters-function-owner" || operation.kind === "revokes-function-public" || operation.kind === "grants-function-execute" || operation.kind === "creates-trigger" || operation.kind === "unknown")
      ? new Set<string>()
      : this.functionNames;
    const mention = mentionOfAny(statement.text, names);
    return mention === undefined ? [] : [`mentions ${mention}, a function the migration chain declares: a call of it, written in any form, would run its body in the migration (D25: migrations stay schema-only), and this check does not tell a call from another use of the name`];
  }

  apply(operation: Operation, alreadyApplied = false): string[] {
    const open = [...this.creatable];
    const before = operation.kind === "declares-function" ? this.functions.get(functionKey(operation.fn)) : undefined;
    const trigger = operation.kind === "creates-trigger" || operation.kind === "drops-trigger" ? this.triggers.get(triggerKey(operation.table, operation.name)) : undefined;
    this.track(operation);
    const problems = this.place(operation, before, trigger, alreadyApplied);
    return open.length > 0 && !FUNCTION_STATEMENTS.has(operation.kind)
      ? [`runs a statement between GRANT CREATE ON SCHEMA ${open.join(", ")} and its REVOKE that is not a CREATE FUNCTION or an ALTER FUNCTION ... OWNER TO ${SYSTEM_ROLE}: while ${SYSTEM_ROLE} holds CREATE on the schema, a migration runs function statements only`, ...problems]
      : problems;
  }

  /**
   * The problems of one operation; `before` is the return type the chain declared for the function it declares,
   * and `trigger` the function and form the chain had a trigger of the same table and name before the trigger
   * it creates. `alreadyApplied` is true only for a REVOKE on named tables inside the file's custom step, when that
   * step's GRANT and REVOKE statements on each of those tables, in order, equal those of the release's latest custom
   * step (`sameTablePrivileges`).
   */
  private place(operation: Operation, before: string | undefined, trigger: TriggerDefinition | undefined, alreadyApplied: boolean): string[] {
    const at = this.tag ?? "the latest release";
    switch (operation.kind) {
      case "drop-table": {
        if (!this.hasTable(operation.table)) {
          return [];
        }
        this.tables.delete(key(operation.table));
        this.definitions.delete(key(operation.table));
        return [(`drops table ${describe(operation.table)}, which exists at ${at}: the previous release still reads it during a rolling deploy`)];
      }
      case "drop-schema": {
        const dropped = [...this.tables.keys()].filter((name) => name.startsWith(`${operation.schema}.`));
        for (const name of dropped) {
          this.tables.delete(name);
          this.definitions.delete(name);
        }
        return dropped.map((name) => (`drops schema ${operation.schema}, which holds table ${name} that exists at ${at}`));
      }
      case "drop-column": {
        if (!this.hasColumn(operation.table, operation.column)) {
          return [];
        }
        this.tables.get(key(operation.table))?.delete(operation.column);
        return [(`drops column ${describe(operation.table)}.${operation.column}, which exists at ${at}: the previous release still reads it during a rolling deploy`)];
      }
      case "rename-table":
      case "set-schema": {
        const columns = this.tables.get(key(operation.table));
        if (columns === undefined) {
          return [];
        }
        this.tables.delete(key(operation.table));
        this.definitions.delete(key(operation.table));
        this.tables.set(key(operation.to), columns);
        const verb = operation.kind === "rename-table" ? "renames" : "moves";
        return [(`${verb} table ${describe(operation.table)} to ${describe(operation.to)}, and it exists under its old name at ${at}`)];
      }
      case "rename-column": {
        const columns = this.tables.get(key(operation.table));
        if (columns?.has(operation.column) !== true) {
          return [];
        }
        columns.delete(operation.column);
        columns.add(operation.to);
        return [(`renames column ${describe(operation.table)}.${operation.column} to ${operation.to}, and it exists under its old name at ${at}`)];
      }
      case "add-column": {
        if (!this.hasTable(operation.table)) {
          return [];
        }
        const problems: string[] = [];
        if (operation.notNullWithoutDefault) {
          problems.push(`adds column ${describe(operation.table)}.${operation.column} as NOT NULL without a default to a table that exists at ${at}: the previous release does not write it`);
        }
        if (operation.rewritesTable) {
          problems.push(`adds column ${describe(operation.table)}.${operation.column} as a serial, identity or generated column to a table that exists at ${at}: the addition rewrites the table under an ACCESS EXCLUSIVE lock`);
        }
        if (!this.constraintFree(operation.type)) {
          const type = operation.type.kind === "named" ? `type ${describe(operation.type.name)}` : "a type this check cannot read";
          problems.push(`adds column ${describe(operation.table)}.${operation.column} of ${type}, which is a domain with constraints or a type this check cannot show to be free of them, to a table that exists at ${at}: the addition validates every row of the table under an ACCESS EXCLUSIVE lock`);
        } else if (!operation.suppliesValue && operation.type.kind === "named" && this.volatileDefaultOf(operation.type)) {
          problems.push(`adds column ${describe(operation.table)}.${operation.column} of type ${describe(operation.type.name)}, a domain whose default is not a constant or a stable call, to a table that exists at ${at}: the addition rewrites the table under an ACCESS EXCLUSIVE lock, since each existing row takes the value of the default`);
        }
        return problems;
      }
      case "alter-column-type":
        return this.hasTable(operation.table)
          ? [(`changes the type of column ${describe(operation.table)}.${operation.column} of a table that exists at ${at}: that can rewrite the table under an ACCESS EXCLUSIVE lock`)]
          : [];
      case "set-not-null":
        return this.hasTable(operation.table)
          ? [(`sets column ${describe(operation.table)}.${operation.column} NOT NULL on a table that exists at ${at}: the previous release can write rows without it, and the change can scan the table under an ACCESS EXCLUSIVE lock (unless a validated CHECK constraint proves it holds no NULL)`)]
          : [];
      case "drop-default":
        return this.hasTable(operation.table)
          ? [(`drops the default of column ${describe(operation.table)}.${operation.column} of a table that exists at ${at}: the previous release can insert rows that rely on it`)]
          : [];
      case "create-index":
        return !operation.concurrently && this.hasTable(operation.table)
          ? [(`creates an index on table ${describe(operation.table)}, which exists at ${at}, without CONCURRENTLY`)]
          : [];
      case "add-validated-constraint":
        return this.hasTable(operation.table)
          ? [(`adds a CHECK or FOREIGN KEY constraint without NOT VALID to table ${describe(operation.table)}, which exists at ${at}: validating it scans the table under its lock, so the release adds it NOT VALID and validates it with VALIDATE CONSTRAINT in a later step`)]
          : [];
      case "add-primary-key-using-index":
        return this.hasTable(operation.table)
          ? [(`attaches an index as the primary key of table ${describe(operation.table)}, which exists at ${at}: that sets its columns NOT NULL if they are not already, which the previous release may still write NULL to, and can scan the table under an ACCESS EXCLUSIVE lock`)]
          : [];
      case "declares-function": {
        this.declared.add(functionKey(operation.fn));
        if (!operation.replace) {
          return [];
        }
        if (before !== undefined) {
          return before === operation.returns
            ? []
            : [`replaces function ${functionLabel(operation.fn)} and changes its return type from ${before || "none"} to ${operation.returns || "none"}: the function exists at ${at}, and the previous release still calls it`];
        }
        return this.functionsKnown
          ? []
          : [`replaces function ${functionLabel(operation.fn)}, which this check cannot show is not a function of ${at}: it could not read every earlier statement, so it cannot show the signature and return type stay as they were`];
      }
      case "alters-function-owner":
        return this.declared.has(functionKey(operation.fn))
          ? []
          : [`changes the owner of function ${functionLabel(operation.fn)}, which this migration does not create: only a function it creates is handed to ${SYSTEM_ROLE}`];
      case "revokes-function-public":
        return this.declared.has(functionKey(operation.fn))
          ? []
          : [`revokes privileges on function ${functionLabel(operation.fn)} from PUBLIC, and this migration does not create it: a running replica may lose the access it uses`];
      case "drops-trigger": {
        // A drop is accepted as one half of a replacement: the file has to create the trigger again with the function and the form it had, which is judged
        // where it does (and at the end of the file, where it does not). It needs the trigger to be one this check can show.
        if (!this.triggersKnown) {
          return [`drops trigger ${operation.name} on ${describe(operation.table)}, which this check cannot show is not a trigger of ${at}: it could not read every earlier statement, so it cannot show the trigger is created again as it was`];
        }
        // A second drop of the same trigger finds it already gone from the model: the definition the first drop recorded stays, until the file
        // creates the trigger again.
        const droppedKey = triggerKey(operation.table, operation.name);
        if (!this.dropped.has(droppedKey)) {
          this.dropped.set(droppedKey, { table: operation.table, name: operation.name, trigger });
        }
        return [];
      }
      case "creates-trigger": {
        const problems = this.triggerFunctions.has(functionKey(operation.fn))
          ? []
          : [`creates a trigger on ${describe(operation.table)} that executes ${functionLabel(operation.fn)}, which no earlier statement of the migration chain declares as a trigger function (a function without arguments that RETURNS trigger): only a trigger function the chain declares is run by a row write`];
        const created: TriggerDefinition = { fn: operation.fn, form: operation.form };
        const dropped = this.dropped.get(triggerKey(operation.table, operation.name));
        if (dropped !== undefined) {
          this.dropped.delete(triggerKey(operation.table, operation.name));
          if (dropped.trigger !== undefined) {
            problems.push(...triggerChange(operation.name, operation.table, dropped.trigger, created));
          }
        }
        if (!operation.replace) {
          return problems;
        }
        if (trigger !== undefined) {
          problems.push(...triggerChange(operation.name, operation.table, trigger, created));
        } else if (!this.triggersKnown) {
          problems.push(`replaces trigger ${operation.name} on ${describe(operation.table)}, which this check cannot show is not a trigger of ${at}: it could not read every earlier statement, so it cannot show the name is not a trigger of the release, which the replacement would change`);
        }
        return problems;
      }
      case "grants-schema-create":
        this.creatable.add(operation.schema);
        return [];
      case "revokes-schema-create":
        return this.creatable.delete(operation.schema)
          ? []
          : [`revokes CREATE on schema ${operation.schema} from ${SYSTEM_ROLE} without granting it in the same file: this check cannot show the release at ${at} does not use it`];
      case "revoke": {
        if (operation.tables === undefined) {
          return [`revokes privileges on a schema, sequence, database or every object of a kind, which this check cannot show the release at ${at} does not use: a running replica may lose access to it`];
        }
        if (alreadyApplied) {
          return [];
        }
        return operation.tables
          .filter((table) => this.hasTable(table))
          .map((table) => `revokes privileges on table ${describe(table)}, which exists at ${at}: the previous release may still rely on that access during a rolling deploy`);
      }
      case "unknown":
        return [(`has a statement this check cannot place (${operation.reason}), so it cannot show that the statement keeps the previous release working`)];
      case "grants-function-execute":
      case "declares-type":
      case "sets-default":
      case "retypes":
      case "data-change":
      case "safe":
        return [];
    }
  }
}

const SHOWN_STATEMENT_LENGTH = 120;

/** The finding for a data-changing statement, which the contract header never licenses. */
function dataChangeMessage(statement: string, text: string): string {
  const flat = text.replace(/\s+/g, " ");
  const shown = flat.length > SHOWN_STATEMENT_LENGTH ? `${flat.slice(0, SHOWN_STATEMENT_LENGTH)}...` : flat;
  return `changes data with ${statement} (${shown}): migrations stay schema-only (D25, doc 05 section 5.2), so a backfill or a data fix is a worker job, and the contract header does not license it`;
}

/** The `-- slugbase:contract` lines in the leading comment block of a file. */
function headerLines(content: string): string[] {
  const lines: string[] = [];
  for (const raw of content.split(/\r\n|\r|\n/)) {
    const line = raw.trim();
    if (line === "") {
      continue;
    }
    if (!line.startsWith("--")) {
      break;
    }
    if (line.startsWith(HEADER_PREFIX)) {
      lines.push(line);
    }
  }
  return lines;
}

/** What is wrong with the contract header of a file, or undefined when it is valid. */
function headerProblem(packageDir: string, content: string, tags: readonly string[], journalTags: ReadonlySet<string>): string | undefined {
  const lines = headerLines(content);
  if (lines.length === 0) {
    return `has no contract header (${HEADER_SYNTAX}) naming the expand migration and the release it pairs with`;
  }
  const match = lines.length === 1 ? HEADER.exec(lines[0] ?? "") : null;
  if (match === null) {
    return `has a malformed contract header (expected exactly one line: ${HEADER_SYNTAX})`;
  }
  const expand = match[1] ?? "";
  const version = (match[2] ?? "").replace(/^v/, "");
  if (!journalTags.has(expand)) {
    return `has a contract header naming ${expand}, which is not a migration of the journal`;
  }
  const tag = tags.find((candidate) => candidate.replace(/^v/, "") === version);
  if (tag === undefined) {
    return `has a contract header naming release ${version}, which is not a release tag of this repository`;
  }
  if (!readReleaseState(packageDir, tag).migrations.includes(expand)) {
    return `has a contract header pairing it with ${expand} in release ${version}, but ${expand} is not part of that release`;
  }
  return undefined;
}

/**
 * A migration the release holds with its statements, for what it declares, or undefined when
 * this check cannot read the file: it then cannot tell what the file did to the types, the functions and the triggers.
 */
function analysedOf(packageDir: string, tag: string): { content: string; statements: AnalysedStatement[] } | undefined {
  const content = readMigration(packageDir, tag);
  if (content === undefined) {
    return undefined;
  }
  try {
    return { content, statements: analyseSql(content) };
  } catch {
    return undefined;
  }
}

/**
 * The custom step of a migration (undefined when it has none) and, when the step as the migration carries it stands at the end of the file's
 * statements, those statements: only they are a re-emit of src/sql/. `stepIsTail` is false when the step does not stand there, and `inStep` is then
 * empty. Throws when the step cannot be scanned.
 */
function customStepOf(content: string, statements: readonly AnalysedStatement[]): { step: AnalysedStatement[] | undefined; stepIsTail: boolean; inStep: Set<AnalysedStatement> } {
  const step = customStep(content);
  const tail = step === undefined ? [] : statements.slice(Math.max(0, statements.length - step.length));
  const stepIsTail = step !== undefined && tail.length === step.length && step.every((statement, index) => statement.text === tail[index]?.text);
  return { step, stepIsTail, inStep: new Set(stepIsTail ? tail : []) };
}

export const expandContractRule: CheckRule = {
  id: ID,
  description:
    "migrations added since the latest release tag do not drop, rename or rewrite what the release holds, unless they are the contract half of an expand/contract pair, with a valid contract header",
  // eslint-disable-next-line @typescript-eslint/require-await -- git is read synchronously; the rule contract allows a promise
  async run({ packageDir }) {
    const journal = readJournal(packageDir);
    const journalTags = new Set(journal.map(({ tag }) => tag));
    const tags = releaseTags(packageDir);
    const latest = tags.at(-1);
    const release = latest === undefined ? undefined : readReleaseState(packageDir, latest);
    const released = new Released(latest, release);
    const shipped = new Set(release?.migrations);
    // The table privileges the release's custom SQL left, read once and only when a migration after it needs them.
    let releasedPrivileges: PrivilegeStatement[] | undefined;
    let releasedRead = false;
    const releasedFor = (): PrivilegeStatement[] | undefined => {
      if (release !== undefined && !releasedRead) {
        releasedPrivileges = readReleasedPrivileges(packageDir, release);
        releasedRead = true;
      }
      return releasedPrivileges;
    };
    // The GRANT and REVOKE statements on functions of the latest custom step so far: of the latest migration added since the release that has one,
    // and before any, of the release's (read once, and only when a REVOKE on a function needs them). undefined is a step this check cannot show.
    let latestStep: { readonly privileges: FunctionPrivilege[] | undefined } | undefined;
    let releasedFunctions: { readonly privileges: FunctionPrivilege[] | undefined } | undefined;
    const previousFunctionPrivileges = (): FunctionPrivilege[] | undefined => {
      if (latestStep !== undefined) {
        return latestStep.privileges;
      }
      if (releasedFunctions === undefined) {
        const step = release === undefined ? undefined : readReleasedStep(packageDir, release);
        releasedFunctions = { privileges: step === undefined ? undefined : functionPrivilegeStatements(step) };
      }
      return releasedFunctions.privileges;
    };
    const findings: Finding[] = [];

    for (const { tag } of journal) {
      if (shipped.has(tag)) {
        const read = analysedOf(packageDir, tag);
        if (read === undefined) {
          released.taint();
          continue;
        }
        // A migration of the release with a valid contract header ran its DROP FUNCTION and function REVOKE statements for every database that
        // reached the release; a later re-emit of them is judged against these as it is against the ones of a migration added since.
        released.startFile();
        let inStep = new Set<AnalysedStatement>();
        try {
          inStep = headerLines(read.content).length > 0 && headerProblem(packageDir, read.content, tags, journalTags) === undefined ? customStepOf(read.content, read.statements).inStep : inStep;
        } catch {
          inStep = new Set();
        }
        for (const statement of read.statements) {
          const functionStatement = inStep.has(statement) ? functionStatementOf(statement) : undefined;
          for (const operation of statement.operations) {
            released.track(operation);
          }
          if (functionStatement !== undefined) {
            released.noteFunctionStatement(functionStatement, statementForm(statement));
          }
        }
        released.commitFunctionStatements();
        continue;
      }
      const object = `migrations/${tag}.sql`;
      const content = readMigration(packageDir, tag);
      if (content === undefined) {
        throw new Error(`migration file ${tag}.sql listed in the journal cannot be read`);
      }
      const problems: string[] = [];
      released.startFile();
      let stepFunctionPrivileges: FunctionPrivilege[] | undefined;
      try {
        const timeout = setsSessionTimeout(content);
        if (timeout !== undefined) {
          findings.push({
            rule: ID,
            object,
            message: `sets ${timeout}: \`migrate\` sets lock_timeout and statement_timeout for its session (doc 05 section 5.2), a migration file does not`,
          });
        }
        const statements = analyseSql(content);
        // A table REVOKE is already applied only inside the file's custom step, and only when the step leaves the
        // table the privileges the release's custom step left it (all its GRANTs and REVOKEs on it, in order).
        const { step, stepIsTail, inStep } = customStepOf(content, statements);
        const stepPrivileges = stepIsTail && step !== undefined ? privilegeStatements(step) : undefined;
        stepFunctionPrivileges = stepIsTail && step !== undefined ? functionPrivilegeStatements(step) : undefined;
        // A DROP FUNCTION or a function REVOKE is already run only inside the file's custom step, and only when an earlier migration with a valid
        // contract header ran the same statement there with nothing since that may bring back what it removed. A REVOKE also needs the step to
        // leave the function the GRANT and REVOKE statements the latest custom step left it.
        const alreadyRun = (functionStatement: FunctionStatement, form: string): boolean => {
          if (!released.ranBefore(functionStatement, form)) {
            return false;
          }
          if (functionStatement.action === "drop") {
            return true;
          }
          const before = previousFunctionPrivileges();
          return before !== undefined && stepFunctionPrivileges !== undefined && sameFunctionPrivileges(before, stepFunctionPrivileges, functionStatement.fn);
        };
        for (const statement of statements) {
          problems.push(...released.callProblem(statement));
          const functionStatement = inStep.has(statement) ? functionStatementOf(statement) : undefined;
          const functionForm = functionStatement === undefined ? "" : statementForm(statement);
          if (functionStatement !== undefined && alreadyRun(functionStatement, functionForm)) {
            continue;
          }
          const [operation, ...rest] = statement.operations;
          const created = createdTableOf(statement);
          if (created !== undefined) {
            problems.push(...released.createProblem(created));
          }
          const revoked = inStep.has(statement) && operation?.kind === "revoke" && rest.length === 0 ? operation.tables : undefined;
          const before = revoked === undefined || stepPrivileges === undefined ? undefined : releasedFor();
          const alreadyApplied = revoked !== undefined && before !== undefined && stepPrivileges !== undefined && revoked.every((table) => sameTablePrivileges(before, stepPrivileges, table));
          for (const operation of statement.operations) {
            if (operation.kind === "data-change") {
              findings.push({ rule: ID, object, message: dataChangeMessage(operation.statement, statement.text) });
            }
            problems.push(...released.apply(operation, alreadyApplied));
          }
          if (functionStatement !== undefined) {
            released.noteFunctionStatement(functionStatement, functionForm);
          }
        }
        problems.push(...released.endFile());
        latestStep = step === undefined ? latestStep : { privileges: stepFunctionPrivileges };
      } catch (error) {
        released.taint();
        latestStep = { privileges: undefined };
        problems.push(
          `cannot be read by this check (${error instanceof Error ? error.message : "unknown error"}), so it cannot show that the file keeps the previous release working`,
        );
      }
      // The statements this migration ran count for the later ones only when its contract header is valid.
      const judged = problems.length > 0 || released.hasPendingFunctionStatements();
      const header = judged ? headerProblem(packageDir, content, tags, journalTags) : undefined;
      if (judged && header === undefined) {
        released.commitFunctionStatements();
      }
      if (problems.length === 0) {
        continue;
      }
      if (header !== undefined) {
        for (const found of problems) {
          findings.push({ rule: ID, object, message: `${found}; it is not accepted: it ${header}` });
        }
      }
    }
    return findings;
  },
};

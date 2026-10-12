// A reader for the SQL of a migration file, just deep enough for the
// expand/contract rule (doc 05 section 5.2): it splits a file into statements
// and names, for each, the operation the rule cares about. It is not a SQL
// parser. It classifies by allow-list: a statement is `safe` only when it is one
// of the forms listed below and calls nothing but known built-ins. Everything
// else (a verb or an ALTER/DROP/CREATE form not listed, a SELECT, a call of any
// other function) comes back as `unknown`, and the rule treats that as "not
// safe", never as "fine".

export interface TableName {
  schema: string;
  name: string;
}

export type Operation =
  | { kind: "drop-table"; table: TableName }
  | { kind: "drop-schema"; schema: string }
  | { kind: "drop-column"; table: TableName; column: string }
  | { kind: "rename-table"; table: TableName; to: TableName }
  | { kind: "set-schema"; table: TableName; to: TableName }
  | { kind: "rename-column"; table: TableName; column: string; to: string }
  | { kind: "add-column"; table: TableName; column: string; type: ColumnType; notNullWithoutDefault: boolean; rewritesTable: boolean; suppliesValue: boolean }
  | { kind: "alter-column-type"; table: TableName; column: string }
  | { kind: "set-not-null"; table: TableName; column: string }
  | { kind: "drop-default"; table: TableName; column: string }
  | { kind: "create-index"; table: TableName; concurrently: boolean }
  | { kind: "add-validated-constraint"; table: TableName }
  | { kind: "add-primary-key-using-index"; table: TableName }
  | { kind: "revoke"; tables: TableName[] | undefined }
  // volatileDefault: whether the default the type states is not a constant or a stable call; undefined when it states none, and a domain then takes its base's.
  | { kind: "declares-type"; name: TableName; ownConstraints: boolean; base: ColumnType; volatileDefault: boolean | undefined }
  // ALTER DOMAIN ... SET DEFAULT or DROP DEFAULT: the default the domain has from now on (false when it has none).
  | { kind: "sets-default"; name: TableName; volatileDefault: boolean }
  | { kind: "retypes"; names: TableName[] }
  | { kind: "data-change"; statement: string }
  | { kind: "safe" }
  // keepsTypes: the statement is one the reader places as unsafe to run, but it declares a type or leaves every type as it is.
  | { kind: "unknown"; reason: string; keepsTypes?: true };

/**
 * The type of a column or the base type of a domain: `builtin` for a type of PostgreSQL's
 * own catalog and for any array type (neither is a domain), `named` for a type the migrations
 * may declare (a name without a schema is in `public`), `unreadable` for text this check does not read.
 */
export type ColumnType = { kind: "builtin" } | { kind: "named"; name: TableName } | { kind: "unreadable" };

export interface AnalysedStatement {
  /** The statement with comments removed, as written otherwise. */
  text: string;
  operations: Operation[];
}

type Token =
  | { kind: "word"; text: string }
  | { kind: "ident"; text: string }
  | { kind: "string"; text: string }
  | { kind: "punct"; text: string };

const DEFAULT_SCHEMA = "public";
const IDENTIFIER_START = /[A-Za-z_\u0080-￿]/;
const IDENTIFIER_PART = /[A-Za-z0-9_$\u0080-￿]/;
// PostgreSQL's whitespace is exactly these characters; JavaScript's \s also
// matches others (U+00A0, ...) that PostgreSQL reads as part of a name.
const WHITESPACE = /[ \t\n\r\f\v]/;
// Words that open a relation or function name which a "(" may follow
// (`ON bookmarks (title)`, `REFERENCES t (id)`) without being a call.
const NAME_INTRODUCERS = new Set(["table", "on", "only", "references", "exists", "function", "procedure"]);
// Words after which a "(" belongs to the grammar, not to a function call.
const SYNTAX_BEFORE_PAREN = new Set([
  "using", "with", "check", "key", "unique", "distinct", "include", "inherits", "where", "in", "any", "all", "some",
  "exists", "and", "or", "not", "as", "when", "then", "else", "case", "is", "between", "like", "ilike", "to", "from",
  "select", "default", "identity", "enum", "btree", "hash", "gin", "gist", "spgist", "brin", "if", "set", "update",
  "delete", "cascade", "restrict", "references", "foreign", "primary", "exclude", "for", "values", "array", "row",
  "varying", "on", "only", "table", "union", "intersect", "except", "join", "limit", "by",
]);
// Built-in functions and type names whose call or modifier a migration may carry. The
// two `app_` functions are the tenant context functions of this package, whose
// definitions this check itself restricts to a single SELECT of built-ins.
const SAFE_CALLS = new Set([
  "nullif", "coalesce", "current_setting", "lower", "upper", "length", "now", "to_tsvector", "setweight",
  "app_workspace_id", "app_account_id",
  "varchar", "char", "character", "numeric", "decimal", "bit", "varbit", "time", "timetz", "timestamp", "timestamptz", "interval",
]);
const SAFE_SCHEMAS = new Set(["public", "pg_catalog"]);
const NOT_A_COLUMN = new Set(["constraint", "primary", "unique", "check", "foreign", "exclude", "like", "not"]);
const TABLE_CONSTRAINTS = new Set(["primary", "unique", "check", "foreign", "exclude", "not"]);
const SERIAL_TYPES = new Set(["serial", "smallserial", "bigserial", "serial2", "serial4", "serial8"]);
// Type names that PostgreSQL's grammar reads as its own types; a quoted name is not one of them.
const SQL_TYPE_WORDS = new Set([
  "integer", "int", "smallint", "bigint", "real", "float", "double", "decimal", "dec", "numeric", "boolean", "char", "character",
  "varchar", "nchar", "national", "bit", "time", "timestamp", "interval",
]);
// Types of pg_catalog by their catalog names, which a quoted name can spell.
const CATALOG_TYPES = new Set([
  ...SERIAL_TYPES, "bool", "bytea", "char", "name", "int2", "int4", "int8", "text", "oid", "json", "jsonb", "jsonpath", "xml", "float4",
  "float8", "bpchar", "varchar", "date", "time", "timetz", "timestamp", "timestamptz", "interval", "bit", "varbit", "numeric", "money",
  "uuid", "tsvector", "tsquery", "inet", "cidr", "macaddr", "macaddr8", "point", "line", "lseg", "box", "path", "polygon", "circle",
  "int4range", "int8range", "numrange", "tsrange", "tstzrange", "daterange", "int4multirange", "int8multirange", "nummultirange",
  "tsmultirange", "tstzmultirange", "datemultirange", "pg_lsn", "pg_snapshot", "txid_snapshot", "xid", "xid8", "cid", "tid", "regclass",
  "regtype", "regproc", "regprocedure", "regoper", "regoperator", "regconfig", "regdictionary", "regnamespace", "regrole", "regcollation",
]);
// Words that end the data type in a column or domain definition.
const AFTER_TYPE = new Set(["collate", "default", "constraint", "not", "null", "check", "primary", "unique", "references", "generated", "compression", "storage"]);

/** Splits a file at its top-level semicolons and removes the comments. Throws on text it cannot scan to the end. */
export function splitSql(source: string): string[] {
  const statements: string[] = [];
  let current = "";
  let index = 0;
  const flush = (): void => {
    if (current.trim() !== "") {
      statements.push(current.trim());
    }
    current = "";
  };
  while (index < source.length) {
    const char = source[index] ?? "";
    const next = source[index + 1] ?? "";
    if (char === "-" && next === "-") {
      // PostgreSQL ends a line comment at a line feed or at a carriage return.
      const end = source.slice(index).search(/[\r\n]/);
      index = end === -1 ? source.length : index + end;
      current += " ";
    } else if (char === "/" && next === "*") {
      let depth = 1;
      let cursor = index + 2;
      while (depth > 0) {
        if (cursor >= source.length) {
          throw new Error("a block comment is not closed");
        }
        if (source.startsWith("/*", cursor)) {
          depth += 1;
          cursor += 2;
        } else if (source.startsWith("*/", cursor)) {
          depth -= 1;
          cursor += 2;
        } else {
          cursor += 1;
        }
      }
      index = cursor;
      current += " ";
    } else if (char === "'" || char === '"') {
      const escapes = char === "'" && /[eE]$/.test(current) && !IDENTIFIER_PART.test(current.at(-2) ?? " ");
      const end = quotedEnd(source, index, char, escapes);
      current += source.slice(index, end);
      index = end;
    } else if (char === "$") {
      const tag = /^\$(?:[A-Za-z_\u0080-￿][A-Za-z0-9_\u0080-￿]*)?\$/.exec(source.slice(index))?.[0];
      const previous = current.at(-1) ?? " ";
      if (tag !== undefined && !IDENTIFIER_PART.test(previous)) {
        const close = source.indexOf(tag, index + tag.length);
        if (close === -1) {
          throw new Error(`a dollar-quoted string ${tag} is not closed`);
        }
        current += source.slice(index, close + tag.length);
        index = close + tag.length;
      } else {
        current += char;
        index += 1;
      }
    } else if (char === ";") {
      flush();
      index += 1;
    } else {
      current += char;
      index += 1;
    }
  }
  flush();
  return statements;
}

function quotedEnd(source: string, start: number, quote: string, backslashEscapes: boolean): number {
  let cursor = start + 1;
  while (cursor < source.length) {
    const char = source[cursor];
    if (backslashEscapes && char === "\\") {
      cursor += 2;
    } else if (char === quote) {
      if (source[cursor + 1] === quote) {
        cursor += 2;
      } else {
        return cursor + 1;
      }
    } else {
      cursor += 1;
    }
  }
  throw new Error(`a ${quote === "'" ? "string literal" : "quoted identifier"} is not closed`);
}

function tokenize(statement: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  while (index < statement.length) {
    const char = statement[index] ?? "";
    if (WHITESPACE.test(char)) {
      index += 1;
    } else if (char === '"') {
      if (/[uU]&$/.test(statement.slice(0, index))) {
        throw new Error("a U& quoted identifier spells names with escapes this check does not decode");
      }
      const end = quotedEnd(statement, index, '"', false);
      tokens.push({ kind: "ident", text: statement.slice(index + 1, end - 1).replaceAll('""', '"') });
      index = end;
    } else if (char === "'") {
      const before = statement.slice(0, index);
      if (/[uU]&$/.test(before)) {
        throw new Error("a U& string spells text with escapes this check does not decode");
      }
      const escapes = /[eE]$/.test(before) && !IDENTIFIER_PART.test(before.at(-2) ?? " ");
      const end = quotedEnd(statement, index, "'", escapes);
      tokens.push({ kind: "string", text: statement.slice(index, end) });
      index = end;
    } else if (char === "$") {
      const tag = /^\$(?:[A-Za-z_\u0080-￿][A-Za-z0-9_\u0080-￿]*)?\$/.exec(statement.slice(index))?.[0];
      const close = tag === undefined ? -1 : statement.indexOf(tag, index + tag.length);
      if (tag !== undefined && close !== -1) {
        tokens.push({ kind: "string", text: statement.slice(index, close + tag.length) });
        index = close + tag.length;
      } else {
        tokens.push({ kind: "punct", text: char });
        index += 1;
      }
    } else if (IDENTIFIER_START.test(char) || /[0-9]/.test(char)) {
      let end = index + 1;
      while (end < statement.length && IDENTIFIER_PART.test(statement[end] ?? "")) {
        end += 1;
      }
      tokens.push({ kind: "word", text: statement.slice(index, end).toLowerCase() });
      index = end;
    } else {
      tokens.push({ kind: "punct", text: char });
      index += 1;
    }
  }
  return tokens;
}

class Cursor {
  position = 0;
  readonly tokens: readonly Token[];

  constructor(tokens: readonly Token[]) {
    this.tokens = tokens;
  }

  peek(offset = 0): Token | undefined {
    return this.tokens[this.position + offset];
  }

  isWord(word: string, offset = 0): boolean {
    const token = this.peek(offset);
    return token?.kind === "word" && token.text === word;
  }

  isPunct(text: string, offset = 0): boolean {
    const token = this.peek(offset);
    return token?.kind === "punct" && token.text === text;
  }

  /** Consumes the words in order when they are all next; otherwise consumes nothing. */
  take(...words: string[]): boolean {
    if (words.every((word, offset) => this.isWord(word, offset))) {
      this.position += words.length;
      return true;
    }
    return false;
  }

  done(): boolean {
    return this.position >= this.tokens.length;
  }

  /** Consumes a `( ... )` group, nested groups included, when one is next and closed; otherwise consumes nothing. */
  skipParenthesised(): boolean {
    if (!this.isPunct("(")) {
      return false;
    }
    let depth = 0;
    for (let index = this.position; index < this.tokens.length; index += 1) {
      const token = this.tokens[index];
      if (token?.kind === "punct" && token.text === "(") {
        depth += 1;
      } else if (token?.kind === "punct" && token.text === ")") {
        depth -= 1;
        if (depth === 0) {
          this.position = index + 1;
          return true;
        }
      }
    }
    return false;
  }

  identifier(): string | undefined {
    const token = this.peek();
    if (token?.kind === "ident" || token?.kind === "word") {
      this.position += 1;
      return token.text;
    }
    return undefined;
  }

  tableName(): TableName | undefined {
    const first = this.identifier();
    if (first === undefined) {
      return undefined;
    }
    if (this.isPunct(".")) {
      this.position += 1;
      const second = this.identifier();
      return second === undefined ? undefined : { schema: first, name: second };
    }
    return { schema: DEFAULT_SCHEMA, name: first };
  }
}

/** Whether the type that starts at `from` is written as an array (`t[]`, `t[3]`, `t ARRAY`). */
function isArrayType(tokens: readonly Token[], from: number): boolean {
  let depth = 0;
  for (let index = from; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token?.kind === "punct" && token.text === "(") {
      depth += 1;
    } else if (token?.kind === "punct" && token.text === ")") {
      depth -= 1;
    } else if (depth === 0 && token?.kind === "punct" && token.text === "[") {
      return true;
    } else if (depth === 0 && token?.kind === "word") {
      if (token.text === "array") {
        return true;
      }
      if (AFTER_TYPE.has(token.text)) {
        return false;
      }
    }
  }
  return false;
}

/**
 * The type that starts at the token `start`. PostgreSQL looks a name without a schema up in pg_catalog
 * first, so a built-in name is the built-in type whatever the migrations declare; a name in any other
 * schema, or one with three parts, is a type the migrations declare or this check cannot place.
 */
function readType(tokens: readonly Token[], start: number): ColumnType {
  const first = tokens[start];
  if (first === undefined || (first.kind !== "word" && first.kind !== "ident")) {
    return { kind: "unreadable" };
  }
  let name: TableName = { schema: DEFAULT_SCHEMA, name: first.text };
  let end = start + 1;
  let builtin = CATALOG_TYPES.has(first.text) || (first.kind === "word" && SQL_TYPE_WORDS.has(first.text));
  if (isPunct(tokens[end], ".")) {
    const second = tokens[end + 1];
    if ((second?.kind !== "word" && second?.kind !== "ident") || isPunct(tokens[end + 2], ".")) {
      return { kind: "unreadable" };
    }
    name = { schema: first.text, name: second.text };
    builtin = first.text === "pg_catalog" && CATALOG_TYPES.has(second.text);
    end += 2;
  }
  return builtin || isArrayType(tokens, end) ? { kind: "builtin" } : { kind: "named", name };
}

/** Whether the definition of a domain, from its base type on, says CHECK or NOT NULL outside parentheses. */
function hasDomainConstraint(tokens: readonly Token[]): boolean {
  let depth = 0;
  for (const [index, token] of tokens.entries()) {
    if (token.kind === "punct" && token.text === "(") {
      depth += 1;
    } else if (token.kind === "punct" && token.text === ")") {
      depth -= 1;
    } else if (depth === 0 && token.kind === "word" && (token.text === "check" || (token.text === "not" && isWord(tokens[index + 1], "null")))) {
      return true;
    }
  }
  return false;
}

/**
 * Whether the default a domain definition states, from its base type on, is not a constant or a call the
 * rule accepts as stable; undefined when the definition has no DEFAULT outside parentheses. An explicit
 * DEFAULT NULL is a default, so it replaces the one of a base domain. A CHECK expression in the same
 * definition is scanned too, which only matters for a domain that has a constraint anyway.
 */
function domainDefault(tokens: readonly Token[]): boolean | undefined {
  let depth = 0;
  for (const [index, token] of tokens.entries()) {
    if (token.kind === "punct" && token.text === "(") {
      depth += 1;
    } else if (token.kind === "punct" && token.text === ")") {
      depth -= 1;
    } else if (depth === 0 && token.kind === "word" && token.text === "default") {
      return firstUnknownCall(tokens.slice(index + 1)) !== undefined;
    }
  }
  return undefined;
}

/** The operations of one statement. */
export function analyseStatement(statement: string): AnalysedStatement {
  const text = statement;
  let tokens: Token[];
  try {
    tokens = tokenize(statement);
  } catch (error) {
    return { text, operations: unknown(error instanceof Error ? error.message : "cannot be read") };
  }
  const verb = tokens[0];
  const cursor = new Cursor(tokens);
  cursor.position = 1;
  let operations: Operation[];
  if (verb?.kind === "word" && verb.text === "alter") {
    operations = alter(cursor);
  } else if (verb?.kind === "word" && verb.text === "drop") {
    operations = drop(cursor);
  } else if (verb?.kind === "word" && verb.text === "create") {
    operations = create(cursor);
  } else if (verb?.kind === "word" && verb.text === "grant") {
    operations = grant(cursor);
  } else if (verb?.kind === "word" && verb.text === "revoke") {
    operations = revoke(cursor);
  } else if (verb?.kind === "word" && verb.text === "comment") {
    operations = comment(cursor);
  } else {
    const shown = verb === undefined ? "nothing" : verb.text;
    operations = unknown(`starts with ${shown}, which this check does not read`);
  }
  if (operations.some((operation) => operation.kind === "unknown")) {
    const statementKind = dataChangeOf(tokens);
    if (statementKind !== undefined) {
      return { text, operations: [{ kind: "data-change", statement: statementKind }] };
    }
  }
  const call = firstUnknownCall(tokens);
  if (call !== undefined && !operations.some((operation) => operation.kind === "unknown")) {
    operations = [...operations, ...unknown(`calls ${call}, which this check does not know to be safe`)];
  }
  return { text, operations };
}

/**
 * The data-changing statement a statement is or holds where the reader can see it: its own
 * verb (INSERT, UPDATE, DELETE, TRUNCATE, MERGE, COPY ... FROM), or one of INSERT INTO,
 * DELETE FROM, MERGE INTO and UPDATE <table> SET nested in it (a CTE, a CREATE TABLE ... AS
 * query, the query of a COPY). A statement inside a string body (DO, a function) is not seen.
 */
function dataChangeOf(tokens: readonly Token[]): string | undefined {
  const verb = tokens[0];
  if (verb?.kind === "word") {
    if (verb.text === "insert" || verb.text === "update" || verb.text === "delete" || verb.text === "truncate" || verb.text === "merge") {
      return verb.text.toUpperCase();
    }
    if (verb.text === "copy" && copiesFrom(tokens)) {
      return "COPY";
    }
  }
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token?.kind !== "word") {
      continue;
    }
    const next = tokens[index + 1];
    if (
      (token.text === "insert" && isWord(next, "into")) ||
      (token.text === "delete" && isWord(next, "from")) ||
      (token.text === "merge" && isWord(next, "into")) ||
      (token.text === "update" && !isWord(tokens[index - 1], "on") && updatesTable(tokens, index + 1))
    ) {
      return token.text.toUpperCase();
    }
  }
  return undefined;
}

/** Whether a COPY statement has a FROM outside parentheses: `COPY t FROM`, not `COPY (query) TO`. */
function copiesFrom(tokens: readonly Token[]): boolean {
  let depth = 0;
  for (const token of tokens) {
    if (token.kind === "punct" && token.text === "(") {
      depth += 1;
    } else if (token.kind === "punct" && token.text === ")") {
      depth -= 1;
    } else if (depth === 0 && token.kind === "word" && token.text === "from") {
      return true;
    }
  }
  return false;
}

/** Whether the tokens from `start` read `[ONLY] name[.name] [*] [[AS] alias] SET`, the head of an UPDATE. */
function updatesTable(tokens: readonly Token[], start: number): boolean {
  const cursor = new Cursor(tokens);
  cursor.position = start;
  cursor.take("only");
  if (isWord(cursor.peek(), "set") || cursor.tableName() === undefined) {
    return false;
  }
  if (cursor.isPunct("*")) {
    cursor.position += 1;
  }
  cursor.take("as");
  if (!cursor.isWord("set")) {
    cursor.identifier();
  }
  return cursor.isWord("set");
}

function unknown(reason: string, keepsTypes = false): Operation[] {
  return [keepsTypes ? { kind: "unknown", reason, keepsTypes: true } : { kind: "unknown", reason }];
}

/** The first `name(` in the tokens that is not grammar, a name followed by its column list, or a known built-in. */
function firstUnknownCall(tokens: readonly Token[]): string | undefined {
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    const open = tokens[index + 1];
    if (token === undefined || (token.kind !== "word" && token.kind !== "ident") || open?.kind !== "punct" || open.text !== "(") {
      continue;
    }
    // Walk back over `schema.name` to the first word of the possibly qualified name.
    let start = index;
    while (start >= 2 && isPunct(tokens[start - 1], ".") && isNameToken(tokens[start - 2])) {
      start -= 2;
    }
    const qualified = start !== index;
    const before = tokens[start - 1];
    if (before?.kind === "word" && NAME_INTRODUCERS.has(before.text)) {
      continue;
    }
    if (token.kind === "word" && !qualified && SYNTAX_BEFORE_PAREN.has(token.text)) {
      continue;
    }
    if (token.kind === "word" && SAFE_CALLS.has(token.text)) {
      const schema = tokens[start];
      if (!qualified || (index - start === 2 && schema !== undefined && SAFE_SCHEMAS.has(schema.text))) {
        continue;
      }
    }
    return `${token.text}()`;
  }
  return undefined;
}

function isPunct(token: Token | undefined, text: string): boolean {
  return token?.kind === "punct" && token.text === text;
}

function isNameToken(token: Token | undefined): boolean {
  return token?.kind === "word" || token?.kind === "ident";
}

/** Reads a name list of DROP TABLE or DROP SCHEMA: `IF EXISTS a, b CASCADE`. */
function dropList<T>(cursor: Cursor, read: () => T | undefined, make: (item: T) => Operation, what: string): Operation[] {
  cursor.take("if", "exists");
  const operations: Operation[] = [];
  for (;;) {
    const item = read();
    if (item === undefined) {
      return unknown(`DROP ${what} without a name this check can read`);
    }
    operations.push(make(item));
    if (!cursor.isPunct(",")) {
      break;
    }
    cursor.position += 1;
  }
  if (!cursor.take("cascade")) {
    cursor.take("restrict");
  }
  return cursor.done() ? operations : unknown(`DROP ${what} with text after the names this check does not read`);
}

function drop(cursor: Cursor): Operation[] {
  if (cursor.take("table")) {
    return dropList(cursor, () => cursor.tableName(), (table) => ({ kind: "drop-table", table }), "TABLE");
  }
  if (cursor.take("schema")) {
    return dropList(cursor, () => cursor.identifier(), (schema) => ({ kind: "drop-schema", schema }), "SCHEMA");
  }
  // DROP INDEX and DROP POLICY name an object of that kind only: PostgreSQL refuses
  // `DROP INDEX bookmarks` for a table (checked against PostgreSQL 18).
  if (cursor.take("index")) {
    cursor.take("concurrently");
    return dropList(cursor, () => cursor.tableName(), () => ({ kind: "safe" }), "INDEX");
  }
  if (cursor.take("policy")) {
    cursor.take("if", "exists");
    return cursor.identifier() !== undefined && cursor.take("on") && cursor.tableName() !== undefined
      ? [{ kind: "safe" }]
      : unknown("DROP POLICY this check cannot read");
  }
  return unknown("a DROP form this check does not read");
}

function create(cursor: Cursor): Operation[] {
  const replace = cursor.take("or", "replace");
  if (cursor.take("function")) {
    return createFunction(cursor);
  }
  if (replace) {
    return unknown("a CREATE OR REPLACE form this check does not read");
  }
  if (cursor.isWord("index") || cursor.isWord("unique")) {
    return createIndex(cursor);
  }
  if (cursor.take("policy")) {
    return [{ kind: "safe" }];
  }
  cursor.take("unlogged");
  if (cursor.take("table")) {
    cursor.take("if", "not", "exists");
    // The column list must be the end of the statement: `(cols) AS <query>`, INHERITS,
    // PARTITION BY and WITH are not read, and a query after AS can write (a DELETE in a CTE).
    return cursor.tableName() !== undefined && cursor.skipParenthesised() && cursor.done()
      ? [{ kind: "safe" }]
      : unknown("CREATE TABLE other than `CREATE TABLE name (...)` with nothing after the column list");
  }
  if (cursor.take("extension")) {
    return [{ kind: "safe" }];
  }
  if (cursor.take("sequence")) {
    return [{ kind: "safe" }];
  }
  if (cursor.take("schema")) {
    cursor.take("if", "not", "exists");
    const named = cursor.identifier() !== undefined;
    const owner = cursor.take("authorization") ? cursor.identifier() !== undefined : true;
    return named && owner && cursor.done() ? [{ kind: "safe" }] : unknown("CREATE SCHEMA other than `CREATE SCHEMA name`");
  }
  if (cursor.take("type")) {
    const name = cursor.tableName();
    return name !== undefined && cursor.take("as", "enum") && cursor.skipParenthesised() && cursor.done()
      ? [{ kind: "declares-type", name, ownConstraints: false, base: { kind: "builtin" }, volatileDefault: false }]
      : unknown("CREATE TYPE other than an enum");
  }
  // A domain is not safe to create in a new migration, but the rule still needs to know it, with its
  // constraints, for the columns that later migrations give its type.
  if (cursor.take("domain")) {
    const name = cursor.tableName();
    cursor.take("as");
    return name === undefined
      ? unknown("a CREATE form this check does not read")
      : [
          ...unknown("a CREATE form this check does not read", true),
          {
            kind: "declares-type",
            name,
            ownConstraints: hasDomainConstraint(cursor.tokens.slice(cursor.position)),
            base: readType(cursor.tokens, cursor.position),
            volatileDefault: domainDefault(cursor.tokens.slice(cursor.position)),
          },
        ];
  }
  return unknown("a CREATE form this check does not read");
}

function createIndex(cursor: Cursor): Operation[] {
  cursor.take("unique");
  if (!cursor.take("index")) {
    return unknown("a CREATE form this check does not read");
  }
  const concurrently = cursor.take("concurrently");
  cursor.take("if", "not", "exists");
  while (!cursor.done() && !cursor.isWord("on")) {
    cursor.position += 1;
  }
  if (!cursor.take("on")) {
    return unknown("CREATE INDEX without an ON clause this check can read");
  }
  cursor.take("only");
  const table = cursor.tableName();
  return table === undefined
    ? unknown("CREATE INDEX on a table this check cannot read")
    : [{ kind: "create-index", table, concurrently }];
}

/**
 * CREATE FUNCTION is read only as `LANGUAGE sql` with one string body that is a
 * single SELECT calling known built-ins: a body of any other language or shape can
 * hold a statement the rule is there to stop, and runs whenever the function is called.
 */
function createFunction(cursor: Cursor): Operation[] {
  const rest = cursor.tokens.slice(cursor.position);
  const language = rest.findIndex((token) => token.kind === "word" && token.text === "language");
  const languageName = rest[language + 1];
  if (language === -1 || languageName?.kind !== "word" || languageName.text !== "sql") {
    return unknown("CREATE FUNCTION in a language other than sql");
  }
  const bodies = rest.flatMap((token, offset) => (token.kind === "string" && isWord(rest[offset - 1], "as") ? [token.text] : []));
  const strings = rest.filter((token) => token.kind === "string");
  const body = bodies[0];
  if (bodies.length !== 1 || strings.length !== 1 || body === undefined) {
    return unknown("CREATE FUNCTION without exactly one string body");
  }
  const dollar = /^(\$(?:[^$]*)\$)([\s\S]*)\1$/.exec(body);
  const inner = dollar !== null ? (dollar[2] ?? "") : body.slice(1, -1).replaceAll("''", "'");
  let statements: string[];
  let bodyTokens: Token[];
  try {
    statements = splitSql(inner);
    bodyTokens = tokenize(statements[0] ?? "");
  } catch {
    return unknown("CREATE FUNCTION with a body this check cannot read");
  }
  const first = bodyTokens[0];
  if (statements.length !== 1 || first?.kind !== "word" || first.text !== "select") {
    return unknown("CREATE FUNCTION whose body is not a single SELECT");
  }
  const call = firstUnknownCall(bodyTokens);
  return call === undefined ? [{ kind: "safe" }] : unknown(`CREATE FUNCTION whose body calls ${call}, which this check does not know to be safe`);
}

function isWord(token: Token | undefined, word: string): boolean {
  return token?.kind === "word" && token.text === word;
}

/** The tokens of each comma-separated action of an ALTER TABLE, split outside parentheses. */
function actionsOf(cursor: Cursor): Token[][] {
  const actions: Token[][] = [[]];
  let depth = 0;
  for (const token of cursor.tokens.slice(cursor.position)) {
    if (token.kind === "punct" && token.text === "(") {
      depth += 1;
    } else if (token.kind === "punct" && token.text === ")") {
      depth -= 1;
    }
    if (depth === 0 && token.kind === "punct" && token.text === ",") {
      actions.push([]);
    } else {
      actions.at(-1)?.push(token);
    }
  }
  return actions;
}

function alter(cursor: Cursor): Operation[] {
  if (cursor.take("table")) {
    return alterTable(cursor);
  }
  if (cursor.take("policy")) {
    return [{ kind: "safe" }];
  }
  if (cursor.take("default", "privileges")) {
    return alterDefaultPrivileges(cursor);
  }
  if (cursor.take("domain")) {
    return alterType(cursor, true);
  }
  if (cursor.take("type")) {
    return alterType(cursor, false);
  }
  // ALTER VIEW and ALTER INDEX accept a table's name too (checked against PostgreSQL 18), so
  // none of the object kinds is read as touching only its own kind.
  return unknown("an ALTER form this check does not read");
}

// ALTER DOMAIN actions that add no constraint and rename nothing.
const DOMAIN_ACTIONS_KEEPING_CONSTRAINTS = [["owner", "to"], ["rename", "constraint"], ["drop", "constraint"], ["drop", "not", "null"]];

/**
 * ALTER DOMAIN and ALTER TYPE are not safe to run in a new migration, and they can change what a
 * name means to the rule: a domain gains a constraint, or a type takes the name of another. Every
 * name such an action touches stops being one this check can show to be free of constraints.
 */
function alterType(cursor: Cursor, domain: boolean): Operation[] {
  const name = cursor.tableName();
  if (name === undefined) {
    return unknown("an ALTER form this check does not read");
  }
  const names = [name];
  let retypes = domain;
  if (cursor.take("rename", "to")) {
    const to = cursor.identifier();
    if (to !== undefined) {
      names.push({ schema: name.schema, name: to });
    }
    retypes = true;
  } else if (cursor.take("set", "schema")) {
    const schema = cursor.identifier();
    if (schema !== undefined) {
      names.push({ schema, name: name.name });
    }
    retypes = true;
  } else if (domain && cursor.take("set", "default")) {
    return [...unknown("an ALTER form this check does not read", true), { kind: "sets-default", name, volatileDefault: firstUnknownCall(cursor.tokens.slice(cursor.position)) !== undefined }];
  } else if (domain && cursor.take("drop", "default")) {
    return [...unknown("an ALTER form this check does not read", true), { kind: "sets-default", name, volatileDefault: false }];
  } else if (domain && DOMAIN_ACTIONS_KEEPING_CONSTRAINTS.some((words) => words.every((word, offset) => cursor.isWord(word, offset)))) {
    retypes = false;
  }
  return retypes
    ? [...unknown("an ALTER form this check does not read"), { kind: "retypes", names }]
    : unknown("an ALTER form this check does not read", true);
}

const DEFAULT_PRIVILEGE_OBJECTS = new Set(["tables", "sequences", "functions", "routines", "types", "schemas"]);
const PRIVILEGES = new Set(["select", "insert", "update", "delete", "truncate", "references", "trigger", "maintain", "usage", "execute", "create", "set"]);

/** Reads `item {, item}` with `read`; false when an item cannot be read, which includes a dangling comma. */
function commaSeparated(cursor: Cursor, read: () => boolean): boolean {
  if (!read()) {
    return false;
  }
  while (cursor.isPunct(",")) {
    cursor.position += 1;
    if (!read()) {
      return false;
    }
  }
  return true;
}

/** One plain name: a word or a quoted identifier, not schema-qualified. */
function plainName(cursor: Cursor): boolean {
  return cursor.identifier() !== undefined && !cursor.isPunct(".");
}

/**
 * ALTER DEFAULT PRIVILEGES [FOR {ROLE | USER} roles] [IN SCHEMA schemas]
 * GRANT privileges ON {TABLES | SEQUENCES | FUNCTIONS | ROUTINES | TYPES | SCHEMAS} TO roles [WITH GRANT OPTION].
 * It sets the privileges of objects created later and touches no object a running replica uses.
 * It is read by its whole shape: a REVOKE, a missing or repeated clause, a name or privilege
 * it cannot place, or any text after the statement leaves it unknown.
 */
function alterDefaultPrivileges(cursor: Cursor): Operation[] {
  const unread = unknown("ALTER DEFAULT PRIVILEGES in a form this check does not read");
  let forRole = false;
  let inSchema = false;
  for (;;) {
    if (!forRole && cursor.take("for")) {
      if ((!cursor.take("role") && !cursor.take("user")) || !commaSeparated(cursor, () => plainName(cursor))) {
        return unread;
      }
      forRole = true;
    } else if (!inSchema && cursor.take("in")) {
      if (!cursor.take("schema") || !commaSeparated(cursor, () => plainName(cursor))) {
        return unread;
      }
      inSchema = true;
    } else {
      break;
    }
  }
  if (!cursor.take("grant")) {
    return unread;
  }
  if (cursor.take("all")) {
    cursor.take("privileges");
  } else {
    const privilege = (): boolean => {
      const token = cursor.peek();
      if (token?.kind !== "word" || !PRIVILEGES.has(token.text)) {
        return false;
      }
      cursor.position += 1;
      return true;
    };
    if (!commaSeparated(cursor, privilege)) {
      return unread;
    }
  }
  const object = cursor.take("on") ? cursor.peek() : undefined;
  if (object?.kind !== "word" || !DEFAULT_PRIVILEGE_OBJECTS.has(object.text)) {
    return unread;
  }
  cursor.position += 1;
  if (!cursor.take("to") || !commaSeparated(cursor, () => plainName(cursor))) {
    return unread;
  }
  cursor.take("with", "grant", "option");
  return cursor.done() ? [{ kind: "safe" }] : unread;
}

const GRANT_PRIVILEGES = new Set([...PRIVILEGES, "connect", "temporary", "temp"]);
const SCHEMA_OBJECTS = new Set(["tables", "sequences", "functions", "procedures", "routines"]);

/** Reads `name {, name}` as table-like names, each `name` or `schema.name`. */
function tableNames(cursor: Cursor): TableName[] | undefined {
  const names: TableName[] = [];
  const ok = commaSeparated(cursor, () => {
    const name = cursor.tableName();
    if (name === undefined || cursor.isPunct(".")) {
      return false;
    }
    names.push(name);
    return true;
  });
  return ok ? names : undefined;
}

/** One privilege, or ALL [PRIVILEGES], with the optional column list of a table privilege. */
function privilegeItem(cursor: Cursor, allowed: ReadonlySet<string>): boolean {
  if (cursor.take("all")) {
    cursor.take("privileges");
  } else {
    const token = cursor.peek();
    if (token?.kind !== "word" || !allowed.has(token.text)) {
      return false;
    }
    cursor.position += 1;
  }
  if (cursor.isPunct("(")) {
    cursor.position += 1;
    if (!commaSeparated(cursor, () => plainName(cursor)) || !cursor.isPunct(")")) {
      return false;
    }
    cursor.position += 1;
  }
  return true;
}

/**
 * The object of a GRANT or REVOKE after `ON`: a list of tables (`TABLE` optional), or a list of
 * sequences, schemas or databases, or `ALL {TABLES | SEQUENCES | FUNCTIONS | PROCEDURES | ROUTINES}
 * IN SCHEMA schemas`. `tables` names the tables a list holds, and is undefined for the other
 * objects. The whole object is undefined when it is not one of these forms; a function or procedure
 * with an argument list, a language and the like are not read.
 */
function privilegeObject(cursor: Cursor): { tables: TableName[] | undefined } | undefined {
  if (cursor.take("all")) {
    const kind = cursor.peek();
    if (kind?.kind !== "word" || !SCHEMA_OBJECTS.has(kind.text)) {
      return undefined;
    }
    cursor.position += 1;
    return cursor.take("in", "schema") && commaSeparated(cursor, () => plainName(cursor)) ? { tables: undefined } : undefined;
  }
  if (cursor.take("sequence") || cursor.take("schema") || cursor.take("database")) {
    return commaSeparated(cursor, () => cursor.tableName() !== undefined && !cursor.isPunct(".")) ? { tables: undefined } : undefined;
  }
  cursor.take("table");
  const tables = tableNames(cursor);
  return tables === undefined ? undefined : { tables };
}

/** `privileges ON object` of a GRANT or REVOKE; undefined when it is not read to the end of the object. */
function privilegesOn(cursor: Cursor): { tables: TableName[] | undefined } | undefined {
  if (!commaSeparated(cursor, () => privilegeItem(cursor, GRANT_PRIVILEGES)) || !cursor.take("on")) {
    return undefined;
  }
  return privilegeObject(cursor);
}

/**
 * GRANT privileges ON object TO roles [WITH GRANT OPTION]. A grant only adds access, so a running
 * replica loses nothing by it. It is read by its whole shape: a role membership, an object it
 * does not read, or any text after the statement leaves it unknown.
 */
function grant(cursor: Cursor): Operation[] {
  const unread = unknown("GRANT in a form this check does not read");
  if (privilegesOn(cursor) === undefined || !cursor.take("to") || !commaSeparated(cursor, () => plainName(cursor))) {
    return unread;
  }
  cursor.take("with", "grant", "option");
  return cursor.done() ? [{ kind: "safe" }] : unread;
}

/**
 * REVOKE [GRANT OPTION FOR] privileges ON object FROM roles [CASCADE | RESTRICT]. A revocation
 * takes access from a role the previous release may still use, so it is a step of its own for the
 * rule to place. It is read by its whole shape, as GRANT is.
 */
function revoke(cursor: Cursor): Operation[] {
  cursor.take("grant", "option", "for");
  const object = privilegesOn(cursor);
  if (object === undefined || !cursor.take("from") || !commaSeparated(cursor, () => plainName(cursor))) {
    return unknown("REVOKE in a form this check does not read");
  }
  if (!cursor.take("cascade")) {
    cursor.take("restrict");
  }
  return cursor.done() ? [{ kind: "revoke", tables: object.tables }] : unknown("REVOKE with text after the roles this check does not read");
}

const COMMENT_OBJECTS: readonly (readonly [words: readonly string[], nameParts: number])[] = [
  [["table"], 2],
  [["column"], 3],
  [["index"], 2],
  [["schema"], 1],
  [["sequence"], 2],
  [["view"], 2],
  [["materialized", "view"], 2],
  [["type"], 2],
  [["extension"], 1],
];

/** Reads `name {. name}` of at most `most` parts. */
function dottedName(cursor: Cursor, most: number): boolean {
  for (let parts = 1; ; parts += 1) {
    if (cursor.identifier() === undefined) {
      return false;
    }
    if (!cursor.isPunct(".")) {
      return true;
    }
    if (parts === most) {
      return false;
    }
    cursor.position += 1;
  }
}

/**
 * COMMENT ON object-kind name IS 'text' | NULL, and COMMENT ON {POLICY | CONSTRAINT} name ON table IS ...
 * A comment changes no object a replica uses. It is read by its whole shape: an object kind it does not
 * read (a function takes an argument list), a text that is not one string literal or NULL, or any text
 * after it leaves it unknown.
 */
function comment(cursor: Cursor): Operation[] {
  const unread = unknown("COMMENT in a form this check does not read");
  if (!cursor.take("on")) {
    return unread;
  }
  if (cursor.take("policy") || cursor.take("constraint")) {
    if (!plainName(cursor) || !cursor.take("on") || !dottedName(cursor, 2)) {
      return unread;
    }
  } else {
    const kind = COMMENT_OBJECTS.find(([words]) => cursor.take(...words));
    if (kind === undefined || !dottedName(cursor, kind[1])) {
      return unread;
    }
  }
  if (!cursor.take("is")) {
    return unread;
  }
  // E'...' reaches the reader as the word `e` followed by the string.
  if (cursor.isWord("e") && cursor.peek(1)?.kind === "string") {
    cursor.position += 1;
  }
  if (cursor.peek()?.kind === "string") {
    cursor.position += 1;
  } else if (!cursor.take("null")) {
    return unread;
  }
  return cursor.done() ? [{ kind: "safe" }] : unread;
}

function alterTable(cursor: Cursor): Operation[] {
  cursor.take("if", "exists");
  cursor.take("only");
  const table = cursor.tableName();
  if (table === undefined) {
    return unknown("ALTER TABLE on a table this check cannot read");
  }
  if (cursor.isPunct("*")) {
    cursor.position += 1;
  }
  const operations: Operation[] = [];
  for (const action of actionsOf(cursor)) {
    operations.push(...(action.length === 0 ? unknown("ALTER TABLE with an empty action") : alterAction(table, new Cursor(action))));
  }
  return operations.length === 0 ? unknown("ALTER TABLE without an action this check can read") : operations;
}

function alterAction(table: TableName, action: Cursor): Operation[] {
  if (action.take("rename", "to")) {
    const to = action.tableName();
    return to === undefined ? unknown("RENAME TO without a name") : [{ kind: "rename-table", table, to: { schema: table.schema, name: to.name } }];
  }
  if (action.take("rename")) {
    if (action.isWord("constraint")) {
      return [{ kind: "safe" }];
    }
    action.take("column");
    const column = action.identifier();
    const to = action.take("to") ? action.identifier() : undefined;
    return column === undefined || to === undefined
      ? unknown("RENAME COLUMN this check cannot read")
      : [{ kind: "rename-column", table, column, to }];
  }
  if (action.take("set", "schema")) {
    const schema = action.identifier();
    return schema === undefined ? unknown("SET SCHEMA without a name") : [{ kind: "set-schema", table, to: { schema, name: table.name } }];
  }
  if (action.take("drop")) {
    if (action.isWord("constraint")) {
      return [{ kind: "safe" }];
    }
    action.take("column");
    action.take("if", "exists");
    const column = action.identifier();
    return column === undefined ? unknown("DROP COLUMN without a name") : [{ kind: "drop-column", table, column }];
  }
  if (action.take("add")) {
    const explicit = action.take("column");
    const first = action.peek();
    if (!explicit && first?.kind === "word" && NOT_A_COLUMN.has(first.text)) {
      return addConstraint(table, action);
    }
    action.take("if", "not", "exists");
    const column = action.identifier();
    if (column === undefined) {
      return unknown("ADD COLUMN without a name");
    }
    const type = readType(action.tokens, action.position);
    const definition = readDefinition(action);
    const operations: Operation[] = [{ kind: "add-column", table, column, type, notNullWithoutDefault: definition.notNull && !definition.supplies, rewritesTable: definition.rewritesTable, suppliesValue: definition.supplies }];
    // A column constraint builds an index or checks every existing row, as the table constraint does.
    if (definition.unique || definition.primaryKey) {
      operations.push({ kind: "create-index", table, concurrently: false });
    }
    if (definition.check || (definition.references && definition.supplies)) {
      operations.push({ kind: "add-validated-constraint", table });
    }
    return operations;
  }
  if (action.take("alter")) {
    action.take("column");
    const column = action.identifier();
    if (column === undefined) {
      return unknown("ALTER COLUMN without a name");
    }
    if (action.isWord("type") || action.take("set", "data")) {
      return [{ kind: "alter-column-type", table, column }];
    }
    // The previous release can write a row without the column or with NULL in it, and
    // can insert rows that rely on its default; SET NOT NULL can also scan the table.
    if (action.take("set", "not", "null")) {
      return [{ kind: "set-not-null", table, column }];
    }
    if (action.take("drop", "default")) {
      return [{ kind: "drop-default", table, column }];
    }
    if (action.take("set", "default")) {
      // A NULL default is not stored: PostgreSQL removes the default, as DROP DEFAULT does.
      return startsWithNull(action) ? [{ kind: "drop-default", table, column }] : [{ kind: "safe" }];
    }
    return action.take("drop", "not", "null") ? [{ kind: "safe" }] : unknown("an ALTER COLUMN form this check does not read");
  }
  const rowLevelSecurity = [["enable", "row", "level", "security"], ["disable", "row", "level", "security"], ["force", "row", "level", "security"], ["no", "force", "row", "level", "security"]];
  if (rowLevelSecurity.some((words) => action.take(...words)) || action.take("owner", "to") || action.take("validate", "constraint")) {
    return [{ kind: "safe" }];
  }
  return unknown("an ALTER TABLE action this check does not read");
}

/**
 * `ADD [CONSTRAINT name] <constraint>`. PRIMARY KEY, UNIQUE and EXCLUDE build an index
 * unless UNIQUE attaches one (`USING INDEX`); attaching a primary key index also sets
 * its columns NOT NULL where they are not. CHECK and FOREIGN KEY scan the table unless
 * they are `NOT VALID`. NOT NULL (PostgreSQL 18) is read as setting the column NOT NULL
 * whatever follows: PostgreSQL 17 accepts NOT VALID for CHECK and FOREIGN KEY only, and
 * 18 also for NOT NULL, which still enforces the constraint on new writes. Anything else
 * stays unread.
 */
function addConstraint(table: TableName, action: Cursor): Operation[] {
  if (action.take("constraint") && action.identifier() === undefined) {
    return unknown("ADD CONSTRAINT without a name");
  }
  const first = action.peek();
  const kind = first?.kind === "word" && TABLE_CONSTRAINTS.has(first.text) ? first.text : undefined;
  if (kind === undefined) {
    return unknown("ADD CONSTRAINT other than PRIMARY KEY, UNIQUE, EXCLUDE, CHECK, FOREIGN KEY or NOT NULL");
  }
  action.position += 1;
  if (kind === "not") {
    const column = action.take("null") ? action.identifier() : undefined;
    return column === undefined ? unknown("ADD NOT NULL without a column name") : [{ kind: "set-not-null", table, column }];
  }
  if (kind === "primary" || kind === "unique") {
    if (kind === "primary" && !action.take("key")) {
      return unknown("ADD PRIMARY without KEY");
    }
    if (action.isWord("using") && action.isWord("index", 1)) {
      return kind === "primary" ? [{ kind: "add-primary-key-using-index", table }] : [{ kind: "safe" }];
    }
    return [{ kind: "create-index", table, concurrently: false }];
  }
  if (kind === "exclude") {
    return [{ kind: "create-index", table, concurrently: false }];
  }
  if (kind === "foreign" && !action.take("key")) {
    return unknown("ADD FOREIGN without KEY");
  }
  const last = action.tokens.at(-1);
  const beforeLast = action.tokens.at(-2);
  return isWord(beforeLast, "not") && isWord(last, "valid") ? [{ kind: "safe" }] : [{ kind: "add-validated-constraint", table }];
}

/** Whether the expression next is `NULL`, parenthesised to any depth or cast (`NULL::text`), and nothing else. */
function startsWithNull(expression: Cursor): boolean {
  let offset = 0;
  while (expression.isPunct("(", offset)) {
    offset += 1;
  }
  if (!expression.isWord("null", offset)) {
    return false;
  }
  offset += 1;
  while (expression.isPunct(")", offset)) {
    offset += 1;
  }
  return expression.peek(offset) === undefined || (expression.isPunct(":", offset) && expression.isPunct(":", offset + 1));
}

/** Whether the `GENERATED` word at the offset starts `GENERATED ALWAYS AS (expression) VIRTUAL`. */
function isVirtualGenerated(definition: Cursor, offset: number): boolean {
  if (!definition.isWord("always", offset + 1) || !definition.isWord("as", offset + 2) || !definition.isPunct("(", offset + 3)) {
    return false;
  }
  let depth = 0;
  for (let at = offset + 3; definition.peek(at) !== undefined; at += 1) {
    if (definition.isPunct("(", at)) {
      depth += 1;
    } else if (definition.isPunct(")", at)) {
      depth -= 1;
      if (depth === 0) {
        return definition.isWord("virtual", at + 1);
      }
    }
  }
  return false;
}

/**
 * What the rest of an ADD COLUMN definition says at its top level (words inside
 * parentheses, such as a type's arguments or a CHECK expression, do not count):
 * NOT NULL, a column constraint that builds an index or is checked against the
 * rows, whether it supplies a value (DEFAULT <expression>, a generated value, identity or a serial type;
 * the DEFAULT of COMPRESSION DEFAULT and STORAGE DEFAULT is no value),
 * and whether it rewrites the table: a serial type, an identity column and a generated column
 * that is not marked VIRTUAL write every existing row (PostgreSQL 17 has stored generated
 * columns only, so a GENERATED form this reader does not recognise counts as rewriting),
 * while a nullable column or a constant or stable DEFAULT is recorded in the catalog alone
 * unless the column's type is a domain with constraints (the type is read by `readType`).
 */
function readDefinition(definition: Cursor): {
  notNull: boolean;
  supplies: boolean;
  rewritesTable: boolean;
  unique: boolean;
  primaryKey: boolean;
  check: boolean;
  references: boolean;
} {
  let depth = 0;
  const found = { notNull: false, supplies: false, rewritesTable: false, unique: false, primaryKey: false, check: false, references: false };
  const type = definition.peek();
  // PostgreSQL matches the serial name after removing quotes, so "serial" is the serial type; the match is case-exact for a quoted name.
  if ((type?.kind === "word" || type?.kind === "ident") && SERIAL_TYPES.has(type.text)) {
    found.supplies = true;
    found.rewritesTable = true;
  }
  for (let offset = 0; definition.peek(offset) !== undefined; offset += 1) {
    const token = definition.peek(offset);
    if (token?.kind === "punct" && token.text === "(") {
      depth += 1;
    } else if (token?.kind === "punct" && token.text === ")") {
      depth -= 1;
    } else if (depth === 0 && token?.kind === "word") {
      if (token.text === "not" && definition.isWord("null", offset + 1)) {
        found.notNull = true;
      } else if (token.text === "default") {
        // COMPRESSION DEFAULT and STORAGE DEFAULT name a method, not a value for the column.
        if (offset === 0 || !(definition.isWord("compression", offset - 1) || definition.isWord("storage", offset - 1))) {
          found.supplies = true;
        }
      } else if (token.text === "generated") {
        found.supplies = true;
        if (!isVirtualGenerated(definition, offset)) {
          found.rewritesTable = true;
        }
      } else if (token.text === "unique") {
        found.unique = true;
      } else if (token.text === "primary" && definition.isWord("key", offset + 1)) {
        found.primaryKey = true;
      } else if (token.text === "check") {
        found.check = true;
      } else if (token.text === "references") {
        found.references = true;
      }
    }
  }
  return found;
}

/** Splits a migration file into statements and reads each. Throws when the file cannot be scanned. */
export function analyseSql(source: string): AnalysedStatement[] {
  const statements = splitSql(source);
  for (const statement of statements) {
    if (/\bbegin\s+atomic\b/i.test(statement)) {
      throw new Error("a BEGIN ATOMIC body holds statements this check does not separate");
    }
  }
  return statements.map(analyseStatement);
}

/** Whether the text, with comments removed, sets one of the migration session's timeouts. */
export function setsSessionTimeout(source: string): string | undefined {
  return splitSql(source)
    .map((statement) => /\b(lock_timeout|statement_timeout)\b/i.exec(statement)?.[1]?.toLowerCase())
    .find((name) => name !== undefined);
}

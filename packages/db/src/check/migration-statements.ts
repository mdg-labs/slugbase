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
  | { kind: "add-column"; table: TableName; column: string; notNullWithoutDefault: boolean }
  | { kind: "alter-column-type"; table: TableName; column: string }
  | { kind: "set-not-null"; table: TableName; column: string }
  | { kind: "drop-default"; table: TableName; column: string }
  | { kind: "create-index"; table: TableName; concurrently: boolean }
  | { kind: "safe" }
  | { kind: "unknown"; reason: string };

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
const NOT_A_COLUMN = new Set(["constraint", "primary", "unique", "check", "foreign", "exclude", "like"]);
const SERIAL_TYPES = new Set(["serial", "smallserial", "bigserial", "serial2", "serial4", "serial8"]);

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
  } else if (verb?.kind === "word" && (verb.text === "grant" || verb.text === "revoke" || verb.text === "comment")) {
    operations = [{ kind: "safe" }];
  } else {
    const shown = verb === undefined ? "nothing" : verb.text;
    operations = unknown(`starts with ${shown}, which this check does not read`);
  }
  const call = firstUnknownCall(tokens);
  if (call !== undefined && !operations.some((operation) => operation.kind === "unknown")) {
    operations = [...operations, ...unknown(`calls ${call}, which this check does not know to be safe`)];
  }
  return { text, operations };
}

function unknown(reason: string): Operation[] {
  return [{ kind: "unknown", reason }];
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
    return cursor.tableName() !== undefined && cursor.take("as", "enum") && cursor.skipParenthesised() && cursor.done()
      ? [{ kind: "safe" }]
      : unknown("CREATE TYPE other than an enum");
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
  // ALTER VIEW and ALTER INDEX accept a table's name too (checked against PostgreSQL 18), so
  // none of the object kinds is read as touching only its own kind.
  return unknown("an ALTER form this check does not read");
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
      return [{ kind: "safe" }];
    }
    action.take("if", "not", "exists");
    const column = action.identifier();
    if (column === undefined) {
      return unknown("ADD COLUMN without a name");
    }
    return [{ kind: "add-column", table, column, notNullWithoutDefault: notNullWithoutDefault(action) }];
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

/** The rest of an ADD COLUMN definition: NOT NULL at its top level and no DEFAULT, generated value, identity or serial type. */
function notNullWithoutDefault(definition: Cursor): boolean {
  let depth = 0;
  let notNull = false;
  let supplies = false;
  const type = definition.peek();
  if (type?.kind === "word" && SERIAL_TYPES.has(type.text)) {
    supplies = true;
  }
  for (let offset = 0; definition.peek(offset) !== undefined; offset += 1) {
    const token = definition.peek(offset);
    if (token?.kind === "punct" && token.text === "(") {
      depth += 1;
    } else if (token?.kind === "punct" && token.text === ")") {
      depth -= 1;
    } else if (depth === 0 && token?.kind === "word") {
      if (token.text === "not" && definition.isWord("null", offset + 1)) {
        notNull = true;
      } else if (token.text === "default" || token.text === "generated") {
        supplies = true;
      }
    }
  }
  return notNull && !supplies;
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

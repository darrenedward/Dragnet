/**
 * Tree-sitter-based symbol + call extractor for TypeScript/JavaScript.
 *
 * Replaces the legacy regex parser for .ts/.tsx/.js/.jsx files. Uses the
 * tree-sitter query DSL for stable, declarative extraction — AST node
 * ranges are exact (no brace-counting), call sites never match keywords
 * (no `if (`/`for (` false positives), and symbol identity is
 * deterministic across re-parses.
 *
 * Grammar dispatch:
 *   .ts, .js → tree-sitter-typescript.wasm  (TS grammar parses JS)
 *   .tsx, .jsx → tree-sitter-tsx.wasm
 *
 * The supported grammar set is documented by the implementation and tests.
 */

import path from "node:path";
import crypto from "node:crypto";
import { Query, type Node } from "web-tree-sitter";

import { getParser, getLanguage, type SupportedExt } from "@/src/lib/treeSitter";
import type { ParsedFile, RawCall, SymbolKind } from "./types";

/**
 * Query patterns for symbol discovery. Captures:
 *   @symbol.def — the AST node spanning the whole symbol (for range)
 *   @symbol.name — the identifier node (for the name text)
 *
 * Kind discrimination is done in code via `kindForNode(node.type)` — the
 * node type itself is unambiguous (function_declaration vs method_definition
 * vs class_declaration vs variable_declarator).
 *
 * Methods are detected via the `method_definition` node type (only appears
 * inside class bodies), so we don't need to track "current class" state
 * the way the regex parser did.
 */
const SYMBOL_QUERY_SRC = `
(function_declaration
  name: (identifier) @symbol.name) @symbol.def

(class_declaration
  name: (type_identifier) @symbol.name) @symbol.def

(method_definition
  name: (property_identifier) @symbol.name) @symbol.def

(method_definition
  name: (private_property_identifier) @symbol.name) @symbol.def

(variable_declarator
  name: (identifier) @symbol.name
  value: [(arrow_function) (function_expression)]) @symbol.def
`.trim();

/**
 * Query patterns for call sites. Captures:
 *   @call.callee — the identifier being called
 *
 * Bare calls `foo()` and method calls `foo.bar()` are both captured; for
 * method calls we grab the property identifier (e.g. `bar` in `foo.bar()`).
 * The orchestrator resolves `toRaw` against the symbol table later.
 *
 * Note: `new Foo()` calls produce `new_expression` nodes, not
 * `call_expression`. v1 doesn't extract those — they're construction
 * sites, less interesting for the call graph than method calls.
 */
const CALL_QUERY_SRC = `
(call_expression
  function: (identifier) @call.callee)

(call_expression
  function: (member_expression
    property: (property_identifier) @call.callee))
`.trim();

interface CachedQuery {
  symbols: Query;
  calls: Query;
}

const globalForTsParser = globalThis as unknown & {
  __tsParserQueries?: Map<SupportedExt, CachedQuery>;
};

async function loadQueries(ext: SupportedExt): Promise<CachedQuery> {
  if (!globalForTsParser.__tsParserQueries) {
    globalForTsParser.__tsParserQueries = new Map();
  }
  const cache = globalForTsParser.__tsParserQueries;
  const cached = cache.get(ext);
  if (cached) return cached;

  const language = await getLanguage(ext);
  const symbols = new Query(language, SYMBOL_QUERY_SRC);
  const calls = new Query(language, CALL_QUERY_SRC);
  const entry = { symbols, calls };
  cache.set(ext, entry);
  return entry;
}

/**
 * Parses a TS/JS/TSX/JSX file into symbols + unresolved call sites.
 *
 * Returns the same shape as `LegacyRegexParser.parseFileSymbols` so the
 * orchestrator can swap parsers without other changes.
 *
 * Throws if tree-sitter init fails or the grammar can't be loaded —
 * callers should catch and log per-file.
 */
export async function parseFileSymbols(
  repoId: string,
  filePath: string,
  content: string,
): Promise<ParsedFile> {
  const ext = path.extname(filePath).toLowerCase() as SupportedExt;
  if (!(ext === ".ts" || ext === ".tsx" || ext === ".js" || ext === ".jsx")) {
    return { symbols: [], rawCalls: [] };
  }

  const { symbols: symbolQuery, calls: callQuery } = await loadQueries(ext);
  const parser = await getParser();
  const language = await getLanguage(ext);
  parser.setLanguage(language);

  const tree = parser.parse(content);
  if (!tree) {
    console.warn(`[tsParser] parse returned null for ${filePath}`);
    return { symbols: [], rawCalls: [] };
  }

  const root = tree.rootNode;
  const languageName = language.name || ext;

  // Pass 1: extract symbols.
  const symbols: ParsedFile["symbols"] = [];
  for (const match of symbolQuery.matches(root)) {
    const defCapture = match.captures.find((c) => c.name === "symbol.def");
    const nameCapture = match.captures.find((c) => c.name === "symbol.name");
    if (!defCapture || !nameCapture) continue;

    const name = nameCapture.node.text;
    if (!name) continue;

    const defNode = defCapture.node;
    const kind = kindForNode(defNode.type);

    symbols.push({
      repoId,
      filePath,
      name,
      kind,
      language: languageName,
      lineStart: defNode.startPosition.row + 1,
      lineEnd: defNode.endPosition.row + 1,
      signature: signatureFromNode(defNode),
      sourceHash: crypto.createHash("md5").update(defNode.text).digest("hex"),
    });
  }

  // Pass 2: extract call sites. For each call, walk up the AST to find
  // the nearest enclosing symbol node and attribute the call to it.
  const rawCalls: RawCall[] = [];
  for (const match of callQuery.matches(root)) {
    const calleeCapture = match.captures.find((c) => c.name === "call.callee");
    if (!calleeCapture) continue;

    const callee = calleeCapture.node.text;
    if (!callee) continue;

    const callExpr = calleeCapture.node.parent;
    if (!callExpr) continue;

    const enclosing = findEnclosingSymbolName(callExpr);
    if (!enclosing) continue;

    rawCalls.push({
      fromSymbolName: enclosing,
      toRaw: callee,
      line: callExpr.startPosition.row + 1,
    });
  }

  tree.delete();

  return { symbols, rawCalls };
}

function kindForNode(nodeType: string): SymbolKind {
  switch (nodeType) {
    case "function_declaration":
      return "function";
    case "class_declaration":
      return "class";
    case "method_definition":
      return "method";
    case "variable_declarator":
      return "function";
    default:
      return "function";
  }
}

/**
 * First line of the symbol node, trimmed — used as a human-readable
 * signature in the symbol table. Tree-sitter gives us the full source
 * text; we just want the declaration header.
 */
function signatureFromNode(node: Node): string {
  const text = node.text;
  const firstLine = text.split("\n")[0].trim();
  return firstLine.length > 200 ? firstLine.slice(0, 200) + "…" : firstLine;
}

/**
 * Walks up the AST from a call expression, returning the name of the
 * nearest enclosing function/method/class. Returns null at module scope.
 *
 * We detect enclosing symbols by node TYPE rather than by reference
 * equality — web-tree-sitter returns fresh JS proxy objects per
 * `Query.matches()` call, so `node === otherNode` is false even when
 * both point at the same underlying tree node. Walking by type is the
 * robust approach.
 *
 * For each enclosing type, the name lives in a child field:
 *   function_declaration, class_declaration → name: (identifier|type_identifier)
 *   method_definition → name: (property_identifier|private_property_identifier)
 *   variable_declarator → name: (identifier)
 */
function findEnclosingSymbolName(startNode: Node): string | null {
  let current: Node | null = startNode;
  while (current) {
    const name = nameOfSymbolNode(current);
    if (name) return name;
    current = current.parent;
  }
  return null;
}

function nameOfSymbolNode(node: Node): string | null {
  switch (node.type) {
    case "function_declaration":
    case "class_declaration":
    case "method_definition":
    case "variable_declarator": {
      // `childForFieldName` returns the field's value if present.
      const nameNode = node.childForFieldName("name");
      return nameNode?.text || null;
    }
    default:
      return null;
  }
}

import { Parser, Language } from "web-tree-sitter";
import { readFile } from "node:fs/promises";
import path from "node:path";

/**
 * Lazy singleton for the tree-sitter parser + per-language grammar cache.
 *
 * Mirrors the llmClient.ts / prisma.ts pattern: globalThis guard, no
 * module-load instantiation. Instantiating heavy
 * clients at module load breaks `next build` on fresh clones. Same hazard
 * applies to tree-sitter (Parser.init pulls a ~200KB WASM runtime; each
 * Language.load pulls a ~1.4MB grammar).
 *
 * Grammars live in `public/grammars/` (copied by scripts/copy-grammars.mjs
 * postinstall hook). We read them as bytes and hand to Language.load so
 * the runtime is robust against CWD / bundler path resolution — relevant
 * under Next 16 + Turbopack where bundlers sometimes rewrite asset URLs.
 *
 * Supported extensions (v1): .ts, .tsx, .js, .jsx.
 *   - .ts and .js → tree-sitter-typescript.wasm (TS grammar parses JS fine)
 *   - .tsx and .jsx → tree-sitter-tsx.wasm
 * Adding a new language is one entry in GRAMMAR_FILES + one npm package.
 * Supported extensions are covered by the tree-sitter parser tests.
 */

const GRAMMAR_FILES: Record<SupportedExt, string> = {
  ".ts": "tree-sitter-typescript.wasm",
  ".js": "tree-sitter-typescript.wasm",
  ".tsx": "tree-sitter-tsx.wasm",
  ".jsx": "tree-sitter-tsx.wasm",
};

export type SupportedExt = ".ts" | ".tsx" | ".js" | ".jsx";

const globalForTreeSitter = globalThis as unknown & {
  __treeSitterParser?: Parser | null;
  __treeSitterLanguages?: Map<string, Language>;
  __treeSitterInitError?: string | null;
};

/**
 * Resolves the on-disk path to a grammar .wasm file. Tries public/grammars/
 * first (postinstall copy target), then falls back to node_modules/ for
 * environments where postinstall hasn't run (e.g. some CI pipelines).
 */
function resolveGrammarPath(filename: string): string {
  const cwd = /* turbopackIgnore: true */ process.cwd();
  const publicPath = path.join(cwd, "public", "grammars", filename);
  const nmPath = path.join(
    cwd,
    "node_modules",
    "tree-sitter-typescript",
    filename,
  );
  // Prefer public/ (postinstall target). Fallback handled by caller via fs read.
  return publicPath;
}

async function loadLanguageFromDisk(filename: string): Promise<Language> {
  const publicPath = path.join(
    /* turbopackIgnore: true */ process.cwd(),
    "public",
    "grammars",
    filename,
  );
  const nmPath = path.join(
    /* turbopackIgnore: true */ process.cwd(),
    "node_modules",
    "tree-sitter-typescript",
    filename,
  );

  let bytes: Uint8Array;
  try {
    bytes = await readFile(publicPath);
  } catch {
    // Fall back to node_modules if postinstall hasn't run.
    bytes = await readFile(nmPath);
  }
  return Language.load(bytes);
}

/**
 * Initializes the tree-sitter WASM runtime. Idempotent. locateFile points
 * at public/grammars/ where we copied web-tree-sitter.wasm; if that's
 * missing, the underlying emscripten loader falls back to its own dir.
 */
export async function getParser(): Promise<Parser> {
  if (globalForTreeSitter.__treeSitterParser) {
    return globalForTreeSitter.__treeSitterParser;
  }
  if (globalForTreeSitter.__treeSitterInitError) {
    throw new Error(globalForTreeSitter.__treeSitterInitError);
  }

  await Parser.init({
    locateFile: (filename: string) =>
      path.join(/* turbopackIgnore: true */ process.cwd(), "public", "grammars", filename),
  });

  const parser = new Parser();
  globalForTreeSitter.__treeSitterParser = parser;
  return parser;
}

/**
 * Loads + caches the grammar for a supported extension. Reads fresh on
 * first call per process; subsequent calls hit the Map on globalThis so
 * dev hot-reload doesn't re-parse 1.4MB of WASM on every request.
 *
 * Throws if the grammar file is missing from both public/grammars/ and
 * node_modules/. Callers should catch and surface "run npm run copy-grammars".
 */
export async function getLanguage(ext: SupportedExt): Promise<Language> {
  if (!globalForTreeSitter.__treeSitterLanguages) {
    globalForTreeSitter.__treeSitterLanguages = new Map();
  }
  const cache = globalForTreeSitter.__treeSitterLanguages;
  const filename = GRAMMAR_FILES[ext];
  const cached = cache.get(filename);
  if (cached) return cached;

  // Parser must be init'd before any Language can be loaded.
  await getParser();

  const language = await loadLanguageFromDisk(filename);
  cache.set(filename, language);
  return language;
}

/**
 * Convenience: derive language from a file path. Returns null for
 * unsupported extensions (caller logs + skips the file).
 */
export async function getLanguageByFilePath(
  filePath: string,
): Promise<Language | null> {
  const ext = path.extname(filePath).toLowerCase();
  if (!(ext in GRAMMAR_FILES)) return null;
  return getLanguage(ext as SupportedExt);
}

/**
 * True if the given file path's extension is supported by the v1 tree-sitter
 * indexer. Cheap synchronous check used by the orchestrator to gate files
 * before reading them off disk.
 */
export function isSupportedFilePath(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  return ext in GRAMMAR_FILES;
}

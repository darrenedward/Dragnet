const CONFIG_FILE_PATTERNS = [
  /\.(json|yaml|yml|toml|ini|cfg|conf|env|env\.[a-zA-Z]+)$/,
  /(^|\/)\.editorconfig$/,
  /(^|\/)\.gitignore$/,
  /(^|\/)\.dockerignore$/,
  /(^|\/)\.prettierrc/,
  /(^|\/)\.eslintrc/,
  /(^|\/)tsconfig.*\.json$/,
  /(^|\/)jsconfig.*\.json$/,
  /(^|\/)babel\.config.*\.(js|json)$/,
  /(^|\/)webpack\.config.*\.(js|ts)$/,
  /(^|\/)vite\.config.*\.(js|ts)$/,
  /(^|\/)rollup\.config.*\.(js|ts)$/,
  /(^|\/)jest\.config.*\.(js|ts)$/,
  /(^|\/)vitest\.config.*\.(js|ts)$/,
  /(^|\/)tailwind\.config.*\.(js|ts)$/,
  /(^|\/)postcss\.config.*\.(js|json)$/,
  /(^|\/)next\.config.*\.(js|ts|mjs)$/,
  /(^|\/)nuxt\.config.*\.(js|ts)$/,
  /(^|\/).node-version$/,
  /(^|\/).nvmrc$/,
  /(^|\/).python-version$/,
  /(^|\/).ruby-version$/,
  /(^|\/).go-version$/,
  /(^|\/)Makefile$/,
  /(^|\/)Dockerfile$/,
  /(^|\/)docker-compose.*\.yml$/,
  /(^|\/)gradle\.properties$/,
  /(^|\/)settings\.gradle$/,
  /(^|\/)build\.gradle$/,
  /(^|\/)pom\.xml$/,
];

const GENERATED_FILE_PATTERNS = [
  /(^|\/)package-lock\.json$/,
  /(^|\/)yarn\.lock$/,
  /(^|\/)pnpm-lock\.yaml$/,
  /(^|\/)bun\.lockb$/,
  /(^|\/)Cargo\.lock$/,
  /(^|\/)go\.sum$/,
  /(^|\/)Gemfile\.lock$/,
  /(^|\/)composer\.lock$/,
  /(^|\/)yarn-error\.log$/,
  /(^|\/)\.next\//,
  /(^|\/)\.turbo\//,
  /(^|\/)dist\//,
  /(^|\/)build\//,
  /(^|\/)target\//,
  /(^|\/)node_modules\//,
  /\.min\.(js|css)$/,
  /\.generated\.(ts|js|tsx|jsx)$/,
];

const DOCS_PATH_PATTERNS = [
  /(^|\/)README/i,
  /(^|\/)CONTRIBUTING/i,
  /(^|\/)LICENSE/i,
  /(^|\/)CHANGELOG/i,
  /(^|\/)AUTHORS/i,
  /(^|\/)CODE_OF_CONDUCT/i,
  /(^|\/)SECURITY/i,
  /(^|\/)SUPPORT/i,
  /(^|\/)docs?\//i,
  /\.(md|mdx|txt|adoc|asciidoc|org|rst)$/,
];

function matchesAny(filename: string, patterns: RegExp[]): boolean {
  const normalized = filename.replace(/\\/g, "/");
  return patterns.some((p) => p.test(normalized));
}

export function isConfigFile(filename: string): boolean {
  return matchesAny(filename, CONFIG_FILE_PATTERNS);
}

export function isGeneratedFile(filename: string): boolean {
  return matchesAny(filename, GENERATED_FILE_PATTERNS);
}

export function isTrivialFile(filename: string): boolean {
  return (
    isConfigFile(filename) ||
    isGeneratedFile(filename) ||
    matchesAny(filename, DOCS_PATH_PATTERNS)
  );
}

export interface DiffClass {
  isTrivial: boolean;
  codeFiles: number;
  trivialFiles: number;
  totalFiles: number;
}

export function classifyDiff(files: Array<{ filename: string }>): DiffClass {
  let codeFiles = 0;
  let trivialFiles = 0;

  for (const f of files) {
    if (isTrivialFile(f.filename)) {
      trivialFiles++;
    } else {
      codeFiles++;
    }
  }

  return {
    isTrivial: codeFiles === 0,
    codeFiles,
    trivialFiles,
    totalFiles: files.length,
  };
}

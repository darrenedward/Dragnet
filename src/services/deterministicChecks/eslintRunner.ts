import { execFileSync } from "node:child_process";
import type { Runner } from "./types";
import { skippedFinding } from "./helpers";
import { parseEslintJson } from "./parsers";

/**
 * Runs `eslint . --format json` (or the project's `npm run lint` script
 * if present) and walks the JSON output into findings.
 *
 * Exit codes:
 *   0 — clean
 *   1 — errors/warnings found (JSON payload still in stdout)
 *   2 — config error or crash
 *
 * When the user has their own `lint` script, we can't assume JSON
 * output, so we run it but return a single info finding prompting
 * manual review rather than trying to parse arbitrary text.
 */
export const eslintRunner: Runner = {
  name: "eslint",
  async run(detection) {
    if (!detection.hasNodeModules) {
      return [skippedFinding("eslint", "node_modules/ missing — run `npm install` to enable eslint checks.")];
    }

    const useScript = Boolean(detection.scripts.lint);
    const args = useScript
      ? ["run", "lint"]
      : ["exec", "eslint", ".", "--format", "json"];

    let raw = "";
    try {
      raw = execFileSync("npm", args, {
        cwd: detection.rootDir,
        encoding: "utf8",
        timeout: 60_000,
        maxBuffer: 10 * 1024 * 1024,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err: any) {
      if (err.status === 1 && err.stdout) {
        raw = err.stdout;
      } else {
        const reason = err.status === 2
          ? "eslint exited with code 2 (config error — check eslint config)"
          : `eslint invocation failed: ${err.message}`;
        return [skippedFinding("eslint", reason)];
      }
    }

    if (useScript) {
      // Their lint script ran — output format unknown. Be honest about it.
      // Strip npm's script-echo prefix ("> name@ver lint\n> cmd\n") so a
      // clean run with no actual lint output returns [] not an info finding.
      const stripped = raw
        .split("\n")
        .filter(l => !l.startsWith(">"))
        .join("\n")
        .trim();
      if (!stripped) return [];
      const parsed = parseEslintJson(stripped, detection.rootDir);
      if (parsed.length > 0) return parsed;
      return [skippedFinding("eslint", `\`npm run lint\` produced unparseable output (${stripped.length} chars) — review manually.`)];
    }

    // Direct eslint --format json — output is always JSON when present.
    // parseEslintJson returns [] for both clean (empty array) and
    // unparseable output. Both mean "no actionable findings."
    return parseEslintJson(raw, detection.rootDir);
  },
};

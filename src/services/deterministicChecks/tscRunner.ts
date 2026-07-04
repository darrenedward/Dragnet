import { execFileSync } from "node:child_process";
import type { Runner } from "./types";
import { skippedFinding } from "./helpers";
import { parseTscOutput } from "./parsers";

/**
 * Runs `tsc --noEmit` (or the project's `npm run typecheck` script if
 * present) and parses the compiler's stdout into findings.
 *
 * Exit codes:
 *   0 — clean (no errors)
 *   1 — errors found (normal operation; stdout has diagnostics)
 *   2 — config error or tsconfig invalid
 *
 * Any other failure (timeout, missing binary, crash) becomes a single
 * `severity: info` skipped finding.
 */
export const tscRunner: Runner = {
  name: "tsc",
  async run(detection) {
    if (!detection.hasNodeModules) {
      return [skippedFinding("tsc", "node_modules/ missing — run `npm install` to enable tsc checks.")];
    }

    const useScript = Boolean(detection.scripts.typecheck);
    const args = useScript ? ["run", "typecheck"] : ["exec", "tsc", "--noEmit"];

    let stdout: string;
    let exitCode = 0;
    try {
      stdout = execFileSync("npm", args, {
        cwd: detection.rootDir,
        encoding: "utf8",
        timeout: 60_000,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err: any) {
      if (err.status === 1) {
        stdout = err.stdout ?? err.stderr ?? "";
        exitCode = 1;
      } else {
        const reason = err.status === 2
          ? "tsc exited with code 2 (config error — check tsconfig.json)"
          : `tsc invocation failed: ${err.message}`;
        return [skippedFinding("tsc", reason)];
      }
    }

    if (exitCode === 0 || !stdout) return [];
    return parseTscOutput(stdout);
  },
};

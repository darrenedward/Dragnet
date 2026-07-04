/**
 * Detector + Runner contract for deterministic checks (tsc, eslint, etc).
 *
 * The orchestrator picks the first matching Detector for a repo, then
 * runs the Runners associated with that ProjectType. Adding a new
 * language = new ProjectType value + new Detector + new Runner file +
 * register in orchestrator. No core changes.
 */

export type ProjectType = "typescript" | "javascript";

export interface DetectionResult {
  type: ProjectType;
  rootDir: string;
  packageJsonPath: string;
  tsconfigPath?: string;
  hasNodeModules: boolean;
  scripts: Record<string, string>;
}

export interface Detector {
  detect(rootDir: string): Promise<DetectionResult | null>;
}

export interface Runner {
  name: "tsc" | "eslint";
  run(detection: DetectionResult): Promise<DeterministicFinding[]>;
}

export interface DeterministicFinding {
  filename: string;
  line: number | null;
  severity: "error" | "warning" | "info";
  category: string;
  explanation: string;
  diffSuggestion?: string | null;
  source: "tsc" | "eslint" | "runner";
}

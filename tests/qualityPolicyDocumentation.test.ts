import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const readme = readFileSync(resolve(process.cwd(), "README.md"), "utf8");
const schema = readFileSync(resolve(process.cwd(), "prisma/schema.prisma"), "utf8");

describe("clean-room quality policy documentation", () => {
  it("documents the deterministic default and non-default full-suite policy", () => {
    expect(readme).toMatch(/typecheck \+ lint/i);
    expect(readme).toMatch(/full unit, integration, and end-to-end suites remain available/i);
    expect(readme).toMatch(/not run by normal PR scans/i);
    expect(readme).toMatch(/merge gate/i);
  });

  it("documents Dragnet PostgreSQL as internal control-plane storage", () => {
    expect(readme).toMatch(/PostgreSQL.*internal control-plane|control-plane.*PostgreSQL/i);
    expect(readme).toMatch(/never exposed to reviewed repositories|not exposed to reviewed repositories/i);
  });

  it("keeps the persisted repository default on deterministic checks", () => {
    expect(schema).toMatch(/testCommand\s+String\s+@default\("npm run typecheck && npm run lint"\)/);
    expect(schema).not.toMatch(/testCommand\s+String\s+@default\([^)]*npm test/);
  });
});

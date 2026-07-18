import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  getPublicUrl,
  publicUrlPathname,
  savePublicUrl,
  validatePublicUrl,
} from "../src/lib/publicUrl";

const originalCwd = process.cwd();
const originalPublicUrl = process.env.DRAGNET_PUBLIC_URL;
const originalServerUrl = process.env.DRAGNET_URL;

afterEach(() => {
  process.chdir(originalCwd);
  if (originalPublicUrl === undefined) delete process.env.DRAGNET_PUBLIC_URL;
  else process.env.DRAGNET_PUBLIC_URL = originalPublicUrl;
  if (originalServerUrl === undefined) delete process.env.DRAGNET_URL;
  else process.env.DRAGNET_URL = originalServerUrl;
});

describe("public URL settings", () => {
  it("falls back to DRAGNET_URL when no public override is saved", () => {
    delete process.env.DRAGNET_PUBLIC_URL;
    process.env.DRAGNET_URL = "http://localhost:3300";

    expect(getPublicUrl()).toEqual({ url: "http://localhost:3300", isLocal: true });
  });

  it("persists the UI-selected server address and normalizes its slash", async () => {
    const tempRoot = join(originalCwd, ".tmp-public-url-test");
    rmSync(tempRoot, { recursive: true, force: true });
    mkdirSync(tempRoot, { recursive: true });
    process.chdir(tempRoot);
    delete process.env.DRAGNET_PUBLIC_URL;
    delete process.env.DRAGNET_URL;

    await savePublicUrl("https://dragnet.example.test/");

    expect(getPublicUrl()).toEqual({ url: "https://dragnet.example.test", isLocal: false });
    expect(existsSync(publicUrlPathname())).toBe(true);
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it("rejects non-http URLs", () => {
    expect(() => validatePublicUrl("javascript:alert(1)")).toThrow("valid http:// or https:// URL");
  });
});

#! /usr/bin/env node
import { createInterface } from "readline";
import { runInit } from "../src/init.mjs";

function ask(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

function printExportInstructions(apiKeyValue, apiBase, keySourceHint) {
  console.log("Add these to your shell profile (~/.zshrc, ~/.bashrc) or .env:");
  console.log("");
  console.log(`  export DRAGNET_API_KEY=${apiKeyValue}`);
  console.log(`  export DRAGNET_URL=${apiBase}`);
  console.log("");
  console.log(keySourceHint);
  console.log("The pre-push hook and /dragnet skill read these env vars directly — no");
  console.log(".dragnet/ config files needed.");
}

const isLocal = process.argv.slice(2).includes("--local");

runInit({ prompt: ask, local: isLocal })
  .then((result) => {
    console.log(`✓ Resolved project "${result.repoId}"`);
    console.log("");
    if (result.apiKey) {
      printExportInstructions(
        result.apiKey,
        result.apiBase,
        "The full key is shown once — copy it now.",
      );
    } else {
      printExportInstructions(
        "dr_xxx",
        result.apiBase,
        `Get the actual key from: ${result.apiBase} (project Settings → API Key).`,
      );
    }
    process.exit(0);
  })
  .catch((err) => {
    console.error(err.message);
    process.exit(1);
  });

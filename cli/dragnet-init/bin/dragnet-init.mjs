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

const isLocal = process.argv.slice(2).includes("--local");

runInit({ prompt: ask, local: isLocal })
  .then((config) => {
    console.log(`✓ Written .dragnet/repo.json (repoId: ${config.repoId})`);
    process.exit(0);
  })
  .catch((err) => {
    console.error(err.message);
    process.exit(1);
  });

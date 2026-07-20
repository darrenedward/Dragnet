<p align="center">
  <img src="./public/dragnet-social-cropped.jpg" alt="Dragnet — self-hosted AI code review" width="100%">
</p>

<p align="center"><a href="https://github.com/darrenedward/Dragnet/issues">Issues</a> · <a href="https://github.com/darrenedward/Dragnet/discussions">Discussions</a> · <a href="./README.md">README</a></p>

# Contributing to Dragnet

Thank you for helping improve Dragnet. The project exists to help teams keep their code understandable, secure, and free of avoidable defects.

We welcome contributions from application developers, AI/ML and LLM engineers, developer-tooling and static-analysis specialists, GitHub integration engineers, debugging and reliability engineers, security researchers, frontend and accessibility practitioners, self-hosting operators, technical writers, and community maintainers.

You do not need to match one of these titles. If you can reproduce a problem, improve a test, clarify a workflow, or make a focused change, you can help.

## Before you start

1. Read the setup and development instructions in [`README.md`](./README.md).
2. Check [existing GitHub issues](https://github.com/darrenedward/Dragnet/issues) before starting work.
3. For a large feature, open an issue first so the scope can be agreed before implementation.

If you are unsure where to begin, look for issues labelled `good first issue`, `help wanted`, or `documentation`, or start a Discussion with the problem you want to solve.

## Development

```bash
npm install
cp .env.example .env.local
npm run lint
npm test
```

Use a focused branch for each change. Keep pull requests small, explain the problem being solved, and include tests for behavior that could regress.

The most useful contributions leave the codebase cleaner than they found it: add a regression test for bugs, preserve actionable error messages, avoid speculative findings, and document setup or recovery steps that another self-hosting user will need.

Before opening a pull request, run:

```bash
npm run lint
npm test
npm run build
```

## Pull requests

Please include:

- the related issue number;
- a short explanation of the change;
- testing performed;
- screenshots for meaningful UI changes;
- any known limitations or follow-up work.

For bug reports, include the smallest reproduction you can, the expected and actual behavior, relevant logs with credentials removed, and the environment details needed to reproduce it. Never post API keys, tokens, private repository contents, or encrypted secret material.

Contributors retain copyright in their contributions. By submitting a contribution, you agree that it may be distributed as part of Dragnet under the GNU Affero General Public License v3.0.

## Code of conduct

Please be respectful and constructive. Harassment, discrimination, and personal attacks are not welcome. If a discussion becomes difficult, maintainers may pause it and ask participants to move the conversation to a more appropriate channel.

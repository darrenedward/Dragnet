# Contributing to Dragnet

Thank you for helping improve Dragnet. Contributions are welcome from developers, security researchers, testers, designers, and documentation writers.

## Before you start

1. Read the project conventions in [`AGENTS.md`](./AGENTS.md) and [`CLAUDE.md`](./CLAUDE.md).
2. Check the roadmap and existing GitHub issues before starting work.
3. For a large feature, open an issue first so the scope can be agreed before implementation.

## Development

```bash
npm install
cp .env.example .env.local
npm run lint
npm test
```

Use a focused branch for each change. Keep pull requests small, explain the problem being solved, and include tests for behavior that could regress.

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

Contributors retain copyright in their contributions. By submitting a contribution, you agree that it may be distributed as part of Dragnet under the GNU Affero General Public License v3.0.

## Code of conduct

Please be respectful and constructive. Harassment, discrimination, and personal attacks are not welcome. If a discussion becomes difficult, maintainers may pause it and ask participants to move the conversation to a more appropriate channel.

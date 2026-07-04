# Skills Setup

**Date:** 2026-07-02

**Status:** Symlinked `/home/curryman/.claude/skills/` → `.agents/skills/`

## What's now available

- **58 global skills** accessible via the symlink
- **22 dart/flutter skills** were in this project but were NOT in `~/.claude/skills/` — they are gone (were never in git, so no record)
- 1 overlap: `ui-ux-pro-max` (was in both)

## To use the new skills in a Claude Code session

1. **Restart the conversation** — my system prompt's `<available_skills>` list is fixed at conversation start
2. Or **invoke via Task tool** with a sub-agent name (some skills work as sub-agents)

## Symlink location

```
.agents/skills -> /home/curryman/.claude/skills
```

## Notes

- `.agents/` is gitignored, so the symlink is local-only
- If the dart/flutter skills are needed, they need to be re-installed (likely via plugin or skill installer)
- Most useful new skills for this codebase: `dragnet`, `code-review`, `final-check`, `tdd`, `triage`

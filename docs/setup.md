# Dragnet Setup Guide

This guide walks through setting up Dragnet for local development and team collaboration.

## Prerequisites

- Node.js 20+
- Postgres database (Supabase or local)
- Git

## Server Setup (One-time, admin only)

1. **Clone the repository:**
   ```bash
   git clone <dragnet-repo-url>
   cd dragnet
   ```

2. **Install dependencies:**
   ```bash
   npm install
   ```

3. **Configure environment:**
   ```bash
   cp .env.example .env.local
   ```
   Edit `.env.local` and set:
   - `DATABASE_URL` — your Postgres connection string
   - `NEXT_PUBLIC_SUPABASE_URL` — Supabase URL (if using Supabase)
   - `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` — Supabase anon key

4. **Generate Prisma client and push schema:**
   ```bash
   npx prisma generate
   npx prisma db push
   ```

5. **Start the dev server:**
   ```bash
   npm run dev
   ```
   Open http://localhost:3300 to access the dashboard.

6. **Configure LLM providers:**
   - Open the **LLM Settings** tab in the dashboard
   - Add your primary and fallback providers for chat and embedding roles
   - Settings are saved to `.dragnet/llm-presets.json` (server-side, gitignored)

## Teammate Onboarding

Once the server is running, each teammate needs to:

### Step 1: Install the CLI (Optional)

The Dragnet CLI (`scripts/dragnet.mjs`) can be used to trigger reviews from the command line or in git hooks.

```bash
# From the dragnet repo
chmod +x scripts/dragnet.mjs
# Optionally symlink to your PATH
ln -s $(pwd)/scripts/dragnet.mjs /usr/local/bin/dragnet
```

### Step 2: Get Repository Access

Ensure you have read access to the repos you'll be reviewing.

### Step 3: Generate an API Key

1. Open the Dragnet dashboard at `http://localhost:3300`
2. Find the project in the sidebar
3. Click that project's key icon
4. Generate a project key and copy the displayed variables

**Important:** Project API keys are scoped to the project and should be kept private. Each teammate or automation client should use an appropriate project key.

### Step 4: Configure Environment Variables

Create a `.env` file in each repo you want to review, or add to your shell profile:

```bash
# In each repo's .env (recommended)
DRAGNET_URL=http://localhost:3300
DRAGNET_REPO_KEY=dr_your_key_here
```

Or add to your shell profile (`.bashrc`, `.zshrc`):

```bash
export DRAGNET_URL=http://localhost:3300
export DRAGNET_REPO_KEY=dr_your_key_here
```

### Step 5: Install Git Hooks (Optional)

To block pushes with low-rated code:

```bash
# From within your repo
node /path/to/dragnet/scripts/dragnet.mjs install-hooks
```

This installs a pre-push hook that runs `dragnet review` before each push.

### Step 6: Register Repos (Admin only)

Repos need to be registered in Dragnet before they can be reviewed:

1. Open the Dragnet dashboard
2. Click **Add Repository**
3. Enter the filesystem path to the repo
4. Click **Index now** to build the code graph

Once indexed, the repo appears in the dashboard and reviews can be triggered.

## Scan queue and automatic rescans

The durable scan queue is shared by dashboard, CLI, webhook, polling, and
pre-push triggers. The global **Max concurrent scans** setting is configured in
LLM Settings. A repository may optionally set a lower cap in its repository
settings; the effective limit is always the lower of the two values. Leaving
the repository field blank uses the global limit.

Automatic rescans are disabled globally by default. Each repository can
inherit that default, explicitly enable automatic rescans, or explicitly
disable them. When enabled, a new PR head commit or a changed head commit is
queued once by its PR-plus-commit identity. Comments, labels, and title edits
do not trigger a scan when the head commit is unchanged.

Queued work can be cancelled or retried from the Scan Queue view. If a worker
stops after writing a valid checkpoint, the lease is recovered and the job is
resumed from that checkpoint rather than creating a second active review run.
An interrupted or cancelled review leaves the PR `Pending`; a PR is
`Completed` only after a review finishes for its current head commit. If a
newer commit arrives while an older scan is queued or running, the older scan
cannot mark the newer revision completed, so the PR remains `Pending` until
the new revision is reviewed.

## Client vs Server Configuration

| Aspect | Client-side | Server-side |
|---------|-------------|-------------|
| **Config location** | `.env` file or shell env | `.dragnet/` directory |
| **Variables** | `DRAGNET_URL`, `DRAGNET_REPO_KEY` | `DATABASE_URL`, LLM presets |
| **Per-user?** | Yes | No (shared by server) |
| **Gitignored?** | No (add `.env` to `.gitignore`) | Yes |

**Server-side `.dragnet/` contents:**
- `llm-presets.json` — LLM provider configuration
- `provider-health.json` — Provider circuit breaker state
- `checkpoints/` — Review run checkpoints
- `reports/` — Scan reports

**Client-side `.env` example:**
```bash
DRAGNET_URL=http://localhost:3300
DRAGNET_REPO_KEY=dr_abc123...
```

## Troubleshooting

### "No API key found"

- Ensure `DRAGNET_REPO_KEY` is set in your `.env` or shell profile
- Verify the key was copied correctly (no extra spaces or newlines)
- Check that the key hasn't been revoked in the dashboard

### "Connection refused"

- Verify `DRAGNET_URL` points to a running Dragnet server
- Check that the server is running (`npm run dev`)
- Ensure no firewall is blocking the port

### "Repository not found"

- Ask an admin to register the repo in the Dragnet dashboard
- Verify the repo path is correct
- Ensure the repo has been indexed at least once

## Next Steps

- See the [project issues](https://github.com/darrenedward/Dragnet/issues) for current priorities and planned work
- Browse the [documentation directory](.) for deployment and feature-specific guidance
- See [`README.md`](../README.md) for the project overview

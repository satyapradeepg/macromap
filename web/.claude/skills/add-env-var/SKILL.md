---
name: add-env-var
description: Add an environment variable (API key, external service URL, config flag) to MacroMap as deployed on the class Azure platform (*.apps.human-angle.com). Use whenever the app needs a new env var in production — an API key for an external service, a setting read via process.env, or anything that works locally with .env but is undefined after deploy.
---

# Add an environment variable to the deployed capstone

This repo is a monorepo: the git root is `macromap/` (with `docs/` and `web/`
as siblings), but the Next.js app itself lives in `macromap/web/`. Because of
that:

- `.github/workflows/deploy.yml` lives at the true **repo root**
  (`macromap/.github/workflows/deploy.yml`) — GitHub only reads workflows
  from a repo's own root, monorepo or not.
- `Dockerfile` lives at `macromap/web/Dockerfile`, and the workflow's
  `az acr build` step points its build context at `./web`.

It deploys to the class Azure platform: a Container App named `ca-<team>` in
resource group `rg-students-platform`, deployed by that workflow on every
merge to `main`. The workflow's CI identity has permission to update **this
team's app only** — all config changes go through the workflow, never
through `az` commands run locally (no Azure write access from a laptop;
don't suggest it).

MacroMap uses Supabase (not Prisma) and pnpm (not npm) — reflected below.

## Step 0 — classify the variable

Ask (or determine from the code) three things, then follow exactly one route:

1. **Is it platform-managed?** `DATABASE_URL`, `AUTH_SECRET`, `AUTH_URL`,
   `PORT`, `HOSTNAME` are already set on the app by the platform.
   **Never set, override, or remove these.** MacroMap doesn't actually use
   `DATABASE_URL` (it talks to Supabase directly), so this mostly won't
   apply here — but still never touch these five names.
2. **Is it secret?** API keys, tokens, passwords, anything from a provider
   dashboard → Route B. Non-secret settings (a public URL, a feature flag,
   a model name) → Route A.
3. **Does client-side code read it?** Any `NEXT_PUBLIC_*` variable → Route C
   (runtime env vars will NOT work for these), regardless of the answers above.
   A secret must never be `NEXT_PUBLIC_*` — that ships it to every browser.

In all routes, also add the variable to the student's local `web/.env` for
development, and verify `.env` is in `.gitignore` (never committed).

## Route A — non-secret runtime variable

Edit `.github/workflows/deploy.yml` (repo root). Add a "Sync app config" step
**after the `azure/login` step and before the "Deploy to Container App"
step** (create it if absent; if it already exists, append to its
`--set-env-vars` list):

```yaml
      - name: Sync app config
        run: |
          az containerapp update \
            --resource-group rg-students-platform \
            --name ca-${{ vars.STUDENT }} \
            --set-env-vars SUPPORT_EMAIL=team@example.com FEATURE_QUIZ=on
```

Values live in the workflow file, versioned like code. `--set-env-vars`
merges — it never removes other variables — and the step is idempotent, so
running on every push is correct.

## Route B — secret runtime variable (API keys)

Two parts: the student stores the value in GitHub, the workflow puts it on
the app.

**1. Student action (GitHub UI — you cannot do this for them; give exact
clicks):** repo **Settings → Secrets and variables → Actions → Secrets tab →
New repository secret**. Name it in `UPPER_SNAKE_CASE` (e.g.
`SPOONACULAR_API_KEY`), paste the value.

⚠️ This is the **Secrets** tab — the opposite of setup day, when the five
deploy values went in the **Variables** tab. Secrets are for values that must
stay hidden; GitHub masks them in logs.

**2. Edit `.github/workflows/deploy.yml`** (repo root) — same placement as
Route A:

```yaml
      - name: Sync app config
        run: |
          az containerapp secret set \
            --resource-group rg-students-platform \
            --name ca-${{ vars.STUDENT }} \
            --secrets spoonacular-api-key="${{ secrets.SPOONACULAR_API_KEY }}"
          az containerapp update \
            --resource-group rg-students-platform \
            --name ca-${{ vars.STUDENT }} \
            --set-env-vars SPOONACULAR_API_KEY=secretref:spoonacular-api-key
```

Naming: the Container App secret name (`spoonacular-api-key`) must be
lowercase letters, numbers, and hyphens only; the env var name matches what
the code reads (`process.env.SPOONACULAR_API_KEY`). Keep the convention:
env var `FOO_BAR` ↔ secret `foo-bar`.

This mirrors how the platform wires its own managed secrets (a secret on the
app, referenced by an env var). The key never appears in code, in the image,
or in logs. MacroMap's known Route B candidates: `SUPABASE_SERVICE_ROLE_KEY`,
`ANTHROPIC_API_KEY`, `SPOONACULAR_API_KEY`, `TAVILY_API_KEY`.

## Route C — `NEXT_PUBLIC_*` variable (build-time)

Next.js inlines `NEXT_PUBLIC_*` values **at build time**, and the build
happens inside `az acr build` — a runtime env var on the Container App does
nothing for these. Two edits:

**1. `web/Dockerfile`** — in the build stage, before `pnpm run build`:

```dockerfile
ARG NEXT_PUBLIC_SUPABASE_URL
ENV NEXT_PUBLIC_SUPABASE_URL=$NEXT_PUBLIC_SUPABASE_URL
RUN pnpm run build
```

**2. `.github/workflows/deploy.yml`** (repo root) — pass it in the build
step, still pointed at the `./web` build context:

```yaml
          az acr build --registry ${{ vars.ACR_NAME }} \
            --image ${{ vars.STUDENT }}/web:${{ github.sha }} \
            --build-arg NEXT_PUBLIC_SUPABASE_URL=https://xyz.supabase.co ./web
```

Never route a secret this way — build args and `NEXT_PUBLIC_*` values end up
readable in the shipped JavaScript. MacroMap's known Route C candidates:
`NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` (the anon key is
designed to be public — it's constrained by Supabase Row Level Security, not
secrecy — but it still must go through this route since it's `NEXT_PUBLIC_*`).

## Guardrails (apply to every route)

- **Never** pass `--command` or any container command override to
  `az containerapp update` — an override persists across all future deploys
  and silently pins the app to stale behavior.
- Values containing a literal `$` get mangled (the platform applies
  shell-style expansion; `$$` collapses to `$`). If a generated key contains
  `$`, regenerate it rather than trying to escape it.
- Quote any value containing spaces.
- Don't `echo` secret values in workflow steps, even "temporarily".
- Removing a variable later: run `--remove-env-vars NAME` once (a one-commit
  change to the sync step), then delete both the flag and, for secrets, the
  GitHub secret.

## Verify

1. Commit on a branch, PR, merge to `main` (the class workflow — never push
   straight to `main`).
2. Watch the **Actions** run go green.
3. Confirm in the app itself (the feature that needed the key now works), or
   in the portal (read-only): `rg-students-platform` → `ca-<team>` →
   **Log stream** — no "missing key"/undefined-variable errors at startup.

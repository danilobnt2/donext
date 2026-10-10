# Contributing

## Development

Requires Node 22 and pnpm (`corepack enable`).

```sh
pnpm install
pnpm dev        # builds the web app, then serves it and the API on http://localhost:8787
pnpm --filter @donext/web dev   # optional: Vite with hot reload, proxying /api to 8787
pnpm lint && pnpm format:check && pnpm typecheck && pnpm test
pnpm test:e2e   # Playwright against a local wrangler dev; first run: pnpm --filter @donext/e2e exec playwright install chromium
pnpm screenshots   # retakes the README screenshots into e2e/screenshots/
```

| Path              | What                                                                                              |
| ----------------- | ------------------------------------------------------------------------------------------------- |
| `apps/web`        | Frontend (Preact + Vite), served by the Worker as static assets                                   |
| `apps/worker`     | Worker (API) and the per-user Durable Object; `wrangler.jsonc` declares every Cloudflare resource |
| `packages/shared` | Types and validation shared by both                                                               |
| `e2e`             | Playwright end-to-end tests (desktop and mobile Chromium)                                         |

After changing `wrangler.jsonc`, run `pnpm --filter @donext/worker types` and commit `worker-configuration.d.ts`.

## Branching

Trunk-based: `master` is the only long-lived branch and is always releasable. There is no `develop` branch.

1. Never commit to `master` directly. Branch from it, named by intent: `feat/…`, `fix/…`, `chore/…` or `docs/…`.
2. Keep branches small and short-lived, merged within hours or days.
3. Open a pull request into `master`. CI must pass (see [Release](#release)).
4. Squash-merge and delete the branch. Because of the squash, git sees the branch as unmerged locally, so remove it with `git branch -D` after checking that `git diff master <branch>` is empty.
5. Releases are not a branch: every push to `master` goes through the release pipeline below, and the production approval gate decides what ships.

Recommended: `git config --global fetch.prune true`, so branches deleted on origin disappear locally on the next fetch.

## Release

Nothing is deployed by hand.

1. **CI** (`.github/workflows/ci.yml`) runs on every pull request to `master`: lint, format, typecheck, unit tests and a build (`Lint, test and build`), plus Playwright end-to-end tests (`E2E`). It must pass before merging.
2. **Release** (`.github/workflows/release.yml`) runs on every push to `master`. It builds once and uploads the web assets and the bundled Worker as an artifact.
3. That artifact is deployed to staging, [donext-staging.orben.dev](https://donext-staging.orben.dev), then smoke-tested.
4. The run waits for approval on the `production` GitHub environment.
5. On approval, it applies D1 migrations, deploys the same artifact to production, [donext.orben.dev](https://donext.orben.dev), and smoke-tests it.

`wrangler deploy` creates the Worker, its custom domain and its Durable Object namespace from `wrangler.jsonc`. Redeploying unchanged config is a no-op. Durable Object SQLite schemas are migrated in code (`apps/worker/src/schema.ts`) the first time each object starts after a deploy. D1 migrations run in the pipeline, before the code that needs them. Keep both backward compatible with the previous release.

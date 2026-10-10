# CLAUDE.md

Before starting any task in this repository, read these in full. Do this at the start of every session, and again before proposing a plan for a new feature.

1. [CONTRIBUTING.md](CONTRIBUTING.md): stack, repo layout, local checks, trunk-based branching and the release pipeline.
2. The **Spec** and **Design** artifacts linked at the top of CONTRIBUTING.md. Read them with the Artifact tool (`action: "read"`), not WebFetch or curl. They describe intent and desired outcome, not fixed design decisions, so use them to understand what we want, and raise it with the user when the code or a request diverges from them.

If a link in CONTRIBUTING.md changes, follow the current link there.

## Rules that follow from them

- Never commit to `master`. Work on a branch named `feat/…`, `fix/…`, `chore/…` or `docs/…`, and keep it small.
- Do not open a pull request unless the user asks for one.
- Before pushing, run `pnpm lint && pnpm format:check && pnpm typecheck && pnpm test`.
- After changing `apps/worker/wrangler.jsonc`, run `pnpm --filter @donext/worker types` and commit `worker-configuration.d.ts`.
- D1 migrations and Durable Object schema migrations must stay backward compatible with the previous release.

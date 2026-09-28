# web-kits

Monorepo for `cross-tab-kit`, `pending-task-kit`, `cross-sqlite-client`.

## Packages

- [`cross-tab-kit`](./packages/cross-tab-kit) — cross-tab primitives (tab-lock, safe-storage, etc.)
- [`pending-task-kit`](./packages/pending-task-kit) — cross-tab task coordination built on `cross-tab-kit`
- [`cross-sqlite-client`](./packages/cross-sqlite-client) — cross-environment SQLite client

All three build with TypeScript's `target: ES2022` (see `tsconfig.base.json`). That target reaches
the published artifacts — it's why `pending-task-kit`'s `dist` emits native class fields — so treat
a change to it as a change to the packages' minimum JS engine, not as a typecheck-only tweak.

## Development

```bash
pnpm install
pnpm typecheck      # = pnpm -r run build && pnpm -r run typecheck
pnpm test           # = pnpm -r run test
pnpm lint
pnpm format:check
```

The canonical verification order is the one CI and `prepublishOnly` use, and it matters:

```
build → pub:check → typecheck → lint → format:check → test
```

`build` comes first because `publint` inspects `dist/`, and because `pending-task-kit`'s
`typecheck` includes `tsc -p test-e2e`, whose fixture imports `../dist/index.js` on purpose (a
build-output smoke test).

Notes on resolution, which is deliberately split:

- Unit tests resolve `cross-tab-kit` to its **source** (`packages/pending-task-kit/vitest.config.ts`
  aliases it, mirroring the `paths` in that package's `tsconfig.json`), so `pnpm test` works on a
  clean checkout with no prior build.
- The e2e suite resolves `pending-task-kit` to its **built `dist/`**, so a stale or broken build is
  caught there. Keep both: source-level unit tests, artifact-level e2e.

Run a per-package script directly with `pnpm --filter <pkg> run <script>`; the repo-wide entries
above are the supported path for "check everything".

### Examples

Each package has a runnable browser demo app (Vite + React) under its `examples/` directory —
see each app's own README for what it exercises:

- `pnpm example:ctk` — cross-tab coordination demos (mutex, leader election, TTL dedupe), port 5174
- `pnpm example:ptk` — pending-task polling against a fake backend, port 5175
- `pnpm example:csc` — a notes CRUD app on SQLite with OPFS persistence, port 5176

The examples are workspace members, so the repo-wide `pnpm typecheck` and `pnpm -r run build`
cover them too. An example's own `build` / `typecheck` scripts read the library's `dist/` and do
not rebuild it (a nested rebuild would race with sibling examples under `pnpm -r`), so to run one
standalone, include its dependencies: `pnpm --filter @examples/cross-tab-kit... run build`.
Only `dev` (the `example:*` scripts) builds the library first.

## Releases

Releases are per-package tags: `<pkg>@<version>` (e.g. `cross-tab-kit@0.5.0`). `changeset version`
bumps the packages, then tag the commit per package and push. Because `pending-task-kit` pins
`cross-tab-kit` exactly (via `workspace:*`, which publishes as the exact version), **publish the
dependency first**: push `cross-tab-kit@x.y.z`, wait for it to publish, then push
`pending-task-kit@a.b.c`. The release workflow's preflight fails loudly if you get that order wrong.

# web-kits

Monorepo for `cross-tab-kit`, `pending-task-kit`, `cross-sqlite-client`.

## Packages

- [`cross-tab-kit`](./packages/cross-tab-kit) — cross-tab primitives (tab-lock, safe-storage, etc.)
- [`pending-task-kit`](./packages/pending-task-kit) — cross-tab task coordination built on `cross-tab-kit`
- [`cross-sqlite-client`](./packages/cross-sqlite-client) — cross-environment SQLite client

## Development

```bash
pnpm install
pnpm -r run typecheck
pnpm -r run test
pnpm -r run build
```

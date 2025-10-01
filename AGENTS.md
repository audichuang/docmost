# Repository Guidelines

## Project Structure & Module Organization
- Monorepo (Nx + pnpm).
- `apps/client`: React + Vite + Mantine (UI).
- `apps/server`: NestJS (API), `integrations/*`, `database/migrations` (Kysely), `core/*`.
- `packages/editor-ext`: Shared editor utilities.
- `.env.example`, `docker-compose.yml` for local setup.

## Build, Test, and Development Commands
- Run all (client + server): `pnpm run dev`.
- Client dev: `pnpm run client:dev`; Server dev: `pnpm run server:dev`.
- Build all: `pnpm run build`; Prod server: `pnpm run start`.
- Server tests: `pnpm --filter server run test`, coverage: `... run test:cov`.
- Lint/format (server): `pnpm --filter server run lint`.
- DB migrations (server):
  - Create: `pnpm --filter server run migration:create <name>`
  - Apply latest: `pnpm --filter server run migration:latest`
  - Codegen types: `pnpm --filter server run migration:codegen`

## Coding Style & Naming Conventions
- TypeScript everywhere; Prettier + ESLint. Use descriptive names; avoid one-letter vars.
- Files: kebab-case; classes/interfaces: PascalCase; vars/functions: camelCase.
- Database: snake_case columns; manage schema only via Kysely migrations.

## Testing Guidelines
- Backend uses Jest (`.spec.ts`). Keep tests near code or under `apps/server/src/**`.
- Write unit tests for services/utils; prefer small, deterministic tests.
- Run `test`/`test:cov` before PRs; include fixtures when practical.

## Commit & Pull Request Guidelines
- Commits: imperative mood, concise scope (e.g., "feat(server): add X").
- PRs: describe intent, list changes, link issues, add screenshots for UI.
- Note any migrations and required env vars; update docs when behavior changes.

## Security & Configuration Tips
- Start from `.env.example`; never commit secrets. Use real services (Postgres/Redis) locally via `docker-compose.yml` if needed.
- For webhooks, ensure raw body support and whitelist paths in `apps/server/src/main.ts` when applicable.

## Agent-Specific Instructions
- Place new integrations under `apps/server/src/integrations/<name>`; import module in `apps/server/src/app.module.ts`.
- Keep migrations in `apps/server/src/database/migrations`; run `migration:codegen` after changes.
- Do not modify `apps/server/src/ee` or `packages/ee` for core features.

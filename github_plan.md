# Docmost × GitHub Connector (One‑Way Sync MVP) — Delivery Plan

Status: Ready to implement

This plan operationalizes the finalized spec for a one‑way GitHub → Docmost sync. It aligns with Docmost’s current monorepo, NestJS backend, Kysely migrations, and Mantine client UI. It adheres to snake_case DB schema, stores GitHub numeric IDs as varchar, supports mapping to a Space or a specific root page, and implements rename/asset handling with webhook and workspace considerations.

-------------------------------------------------------------------------------

## 1) Scope & Outcomes

- Connect a Workspace to one or more GitHub App installations.
- For each selected repo/branch/root_dir, create a Source mapped to a Space or a root page.
- Full import: sync `*.md|*.mdx` and assets; rewrite relative links to Docmost attachments.
- Incremental sync: handle push events (added/modified/removed/renamed) precisely; renames do not recreate pages.
- Keep Docmost permissions as‑is (Space/Group/Share). No author sync from GitHub.

Out of scope (V2): Docmost → GitHub PRs, massive repo partitioning, non‑Markdown conversions.

Success criteria (DoD):
- ≥3 repos, each ≥200 pages and ≥1000 assets, complete full import within a reasonable time (no crashes), images render correctly.
- A single file push updates only its page; remove deletes/archives page; rename preserves page identity.
- Admin can manage installations and sources via the UI, trigger rescan, and view last sync status.

-------------------------------------------------------------------------------

## 2) Architecture Overview

Backend (NestJS): `apps/server/src/integrations/github/`
- `github.module.ts`: Wire controllers/services.
- `github.controller.ts`: REST for installations, repos, sources, rescan.
- `github.webhook.controller.ts`: GitHub App webhook endpoint with HMAC‑SHA256 validation.
- `github.service.ts`: App JWT, Installation Token, Trees, Contents, Compare, ETag logic.
- `github.sync.service.ts`: Full + incremental sync, rename, safe retries.
- `github.link-rewriter.ts`: Fetch raw assets → Storage; rewrite links in HTML.
- `github.mapper.ts`: Markdown → HTML → TipTap JSON using existing import pipeline.
- `github.types.ts`: DTOs/enums.

Frontend (React + Mantine): `apps/client/src/features/integrations/github/`
- `pages/IntegrationsGithubPage.tsx`
- Components: `GithubInstallCard`, `RepoSelector`, `SourceTable`, `SyncStatusTag`
- Client service: `github-integration-api.ts`
- Route: `/settings/integrations/github` (add a new “Integrations → GitHub” menu item in settings sidebar).

Key re‑use points:
- Markdown/HTML → TipTap JSON conversion and formatting: see `apps/server/src/integrations/import/services/import.service.ts:1` and `apps/server/src/integrations/import/utils/import-formatter.ts:1`.
- Storage + attachments: see `apps/server/src/integrations/storage/storage.service.ts:7` and `apps/server/src/integrations/import/services/import-attachment.service.ts:1`.

Workspace guard exception:
- Add `/api/integrations/github/webhook` to the excluded paths in `apps/server/src/main.ts:56` alongside the Stripe webhook.

-------------------------------------------------------------------------------

## 3) Data Model (Kysely, snake_case)

Add four tables with indices and constraints. All GitHub numeric IDs stored as `varchar` to avoid JS bigint hazards.

- `github_installations`
  - `id uuid PK default gen_uuid_v7()`
  - `workspace_id uuid` FK → `workspaces.id` (not null)
  - `app_id varchar` (not null)
  - `installation_id varchar` (not null)
  - `account_login varchar` (not null)
  - `account_type varchar` (not null, 'User'|'Organization')
  - timestamps; unique `(workspace_id, installation_id)`

- `github_sources`
  - `id uuid PK`
  - `workspace_id uuid` FK → `workspaces.id` (not null)
  - `space_id uuid` FK → `spaces.id` (not null)
  - `github_installation_id uuid` FK → `github_installations.id` (not null)
  - `owner varchar`, `repo varchar`, `ref varchar` (all not null)
  - `root_dir varchar not null default ''`
  - `root_page_id uuid` nullable (mount under specific page; null = space root)
  - `mode varchar not null default 'readonly'`, `active boolean not null default true`
  - `last_full_scan_sha varchar` (nullable)
  - timestamps; unique `(space_id, owner, repo, ref, root_dir)`; indices on `(github_installation_id)`, `(workspace_id, updated_at)`

- `github_files`
  - `id uuid PK`
  - `source_id uuid` FK → `github_sources.id` on delete cascade (not null)
  - `path text not null` (repo‑relative including root_dir)
  - `content_type varchar not null` ('markdown'|'asset')
  - `page_id uuid` nullable FK → `pages.id` on delete set null
  - `sha varchar`, `etag varchar`, `title text`, `status varchar default 'synced'`, `renamed_from_path text`
  - `created_at timestamptz default now()`, `updated_at timestamptz default now()`
  - unique `(source_id, path)`; indices `(source_id, sha)`, `(source_id, updated_at)`

- `github_webhook_events`
  - `id uuid PK`, `github_installation_id uuid` FK → `github_installations.id`
  - `delivery_id varchar unique`, `event varchar not null`
  - `repo_full_name varchar`, `before_sha varchar`, `after_sha varchar`
  - `files_json jsonb`, `processed boolean default false`, `ok boolean`, `error text`
  - `created_at timestamptz default now()`; index on `(created_at)`

Migration location: `apps/server/src/database/migrations`.

CLI:
- Create: `pnpm --filter server run migration:create 2025XXXX_github`
- Apply latest: `pnpm --filter server run migration:latest`
- Codegen types: `pnpm --filter server run migration:codegen`

-------------------------------------------------------------------------------

## 4) Backend Endpoints (MVP)

Base path: `/api/integrations/github`

- `GET /installations`
  - List installations for current workspace.
- `GET /repos?githubInstallationId=...`
  - List repositories visible to the installation (via Installation Token).
- `POST /sources`
  - Body: `{ installationId, owner, repo, ref, rootDir?, spaceId, rootPageId? }`
  - Create source record, trigger full sync (async or inline MVP).
- `GET /sources`
  - List sources for workspace; filter by `spaceId` as needed.
- `PATCH /sources/:id`
  - Update source (toggle `active`, change `ref`/`root_dir`/`root_page_id`).
- `DELETE /sources/:id`
  - Soft delete or archive; do not delete Space content automatically.
- `POST /sources/:id/rescan`
  - Trigger full rescan.
- `POST /webhook`
  - GitHub App webhook. Validates `X-Hub-Signature-256`, handles `push|ping|installation`.

Authentication/Authorization:
- Use existing guards (`JwtAuthGuard`) and Space Ability checks similar to Import/Export controllers.
- Webhook endpoint bypasses workspace requirement in `apps/server/src/main.ts:56` excludedPaths.

-------------------------------------------------------------------------------

## 5) Sync Flows

### 5.1 Full Sync (per Source)
1) Resolve Installation Token via `github_installation_id` → lookup `github_installations.installation_id` and exchange token.
2) List tree: `GET /repos/{owner}/{repo}/git/trees/{ref}?recursive=1`.
3) Partition into markdown files (`*.md|*.mdx`) and assets (images/docs).
4) For each markdown file:
   - Fetch content via Contents API with `If-None-Match` (ETag).
   - Convert Markdown → HTML → format (link/embeds) → rewrite relative links to attachments (fetch raw → upload to Storage) → HTML → TipTap JSON.
   - Upsert Page (create if missing, update if exists); set parent to `root_page_id` or Space root.
   - Upsert `github_files` with `sha/etag/page_id/title/content_type='markdown'`.
5) For each asset file (MVP optional record):
   - Optionally upsert `github_files` with `content_type='asset'`, `sha/etag` to support future precise asset updates.

Pseudocode snippet:
```
for path in tree.files:
  if isMarkdown(path):
    content, etag = getContentIfChanged(path, etagCache)
    if content:
      html = markdownToHtml(content)
      html2 = rewriteLinks(html, fetchRawToStorage)
      json = htmlToJson(html2)
      page = upsertPage(json, parent=rootPage)
      upsertGithubFile(path, pageId=page.id, etag, sha, content_type='markdown')
```

### 5.2 Incremental Sync (on `push`)
1) Validate webhook signature; record event (dedupe by `delivery_id`).
2) Determine diffs via Compare API `GET /compare/{before}...{after}` or payload `commits[].{added,modified,removed}`.
3) For each changed file:
   - `added|modified` (markdown): same pipeline as full sync single file; update `github_files`.
   - `removed` (markdown): mark `github_files.status='deleted'`; archive/remove page (soft delete per current behavior).
   - `renamed` (markdown): update `github_files.path` (preserve page), set `renamed_from_path`.
   - `assets`: MVP: update `github_files` rows if recorded or skip; provide manual rescan entry point.
4) Mark webhook event processed with `ok/error`.

Retries/backoff:
- On 429 or transient errors, apply exponential backoff; limit total attempts per file.

-------------------------------------------------------------------------------

## 6) Link Rewriting & Attachments

Strategy mirrors import pipeline but sources files from GitHub raw:
- Detect `<img|video|a>` with relative URLs; resolve against the markdown file’s directory.
- Fetch raw content via Installation Token; upload to Storage (`StorageService`).
- Insert `attachments` DB records and rewrite URLs to `/api/files/{attachmentId}/{fileName}`.
- For bookmarks/embeds/external URLs, pass through to existing formatter (`defaultHtmlFormatter`).

Reference implementations:
- Import formatting: `apps/server/src/integrations/import/utils/import-formatter.ts:1`
- Attachment processing: `apps/server/src/integrations/import/services/import-attachment.service.ts:1`

MVP caveat: precise “assets‑only” updates are deferred; provide “Rescan source” to reconcile.

-------------------------------------------------------------------------------

## 7) Permissions & Workspace

- General REST endpoints use existing auth + Space Ability validation similar to imports:
  - See `apps/server/src/integrations/import/import.controller.ts:1` for guard & ability usage pattern.
- Webhook endpoint is exempt from workspace guard by adding to excluded paths in `apps/server/src/main.ts:56`.

-------------------------------------------------------------------------------

## 8) Environment Variables

```
GITHUB_APP_ID=
GITHUB_APP_CLIENT_ID=
GITHUB_APP_PRIVATE_KEY=      # PEM (recommend secret manager or base64)
GITHUB_APP_WEBHOOK_SECRET=
GITHUB_API_BASE=https://api.github.com
GITHUB_API_VERSION=2022-11-28
```

Token lifecycle:
- App JWT → Installation Token (1h TTL, auto‑refresh). Use ETag on Contents API.

-------------------------------------------------------------------------------

## 9) Frontend Plan (Mantine)

Route: `/settings/integrations/github`

Components:
- `GithubInstallCard`: List installations (account_login, org/user, repo count). “Install/Disconnect” buttons.
- `RepoSelector`: Select installation → repos → branch → root_dir → choose Space or create → optional root_page.
- `SourceTable`: Columns (Space, owner/repo, ref, root_dir, root_page, status, last sync, actions: rescan, disable, delete).
- `SyncStatusTag`: idle/syncing/success/error. Click to view recent webhook events.

API client: `services/github-integration-api.ts` with typed DTOs.

Sidebar entry: add “Integrations → GitHub” to settings menu similar to existing pages in `apps/client/src/components/settings/settings-sidebar.tsx:1`.

-------------------------------------------------------------------------------

## 10) Testing Strategy

Unit tests:
- `github.service`: JWT creation, Installation Token exchange (mock), Trees/Contents/Compare (mock), ETag conditional.
- `github.link-rewriter`: relative path resolution, storage upload integration (mock), HTML rewrite.
- `github.sync.service`: full + incremental flows, rename, removed handling, error paths.

Integration tests:
- Simulate webhook with valid signature; verify single‑file update/rename/delete behaviors.
- Full import of a sample repo (fixture) with images/attachments; verify page count, attachments linked.

E2E acceptance:
- Admin flow: install app → create source → full sync → push → see change within seconds.
- Permissions: non‑members cannot access synced pages.

-------------------------------------------------------------------------------

## 11) Performance & Reliability

- Use ETag with `If-None-Match` for Contents API to reduce quota.
- Compare API to get accurate change sets across rebases.
- Batched processing for large trees; provide UI progress feedback.
- Optional BullMQ queue for concurrency/backoff if push volume is high (module exists but MVP can be inline with safe guards).

-------------------------------------------------------------------------------

## 12) Delivery Milestones

M1 — Data & Module Scaffolding (1–2d)
- [x] Add 4 migrations
- [x] Run `migration:latest` + `migration:codegen`
- [x] Add `GithubModule` files with controller/service skeletons
- [x] Whitelist webhook path in `apps/server/src/main.ts:56`
- [x] Add env vars to `.env.example`
- [x] Harden controllers & webhook (JwtAuthGuard, workspace-scoped sources, verified rescan, env getters, webhook signature checks)

M2 — Full Sync (3–5d)
- [x] Implement `github.service` (auth + API wrappers).
- [x] Implement `github.mapper` and `github.link-rewriter` (remote fetch → storage → HTML rewrite → TipTap JSON).
- [x] Implement `github.sync.service.fullSync`.
- [x] API: `POST /sources`, `GET /sources`, `POST /sources/:id/rescan`.

M3 — Incremental Sync (2–3d)
- Implement webhook controller with signature validation.
- [x] Implement `handlePush` (added/modified/removed/renamed) with rename updates.
- [x] Record `github_webhook_events` with status and errors.
- [x] Deduplicate webhook delivery processing (skip on conflict)
- [x] Update github_files.updated_at for 304 scans
- [x] Basic API backoff (429/5xx)

 M4 — Frontend (2–3d)
 - [x] Settings route + sidebar entry.
 - [x] Pages and components (InstallCard, RepoSelector, SourceTable, SyncStatusTag).
 - [x] API client integration + optimistic statuses.
 - [x] Actions: Disable/Enable/Delete + immediate refresh

M5 — Hardening & QA (2–3d)
- Unit/integration tests.
- Large repo smoke tests; adjust batch size/backoff; log & metrics.
- Docs: Admin setup guide and env var notes.

-------------------------------------------------------------------------------

## 13) Operational Notes

Local dev:
- Run services: `pnpm run dev` (client + server) or individually via Nx.
- DB migrations: `pnpm --filter server run migration:latest` → `pnpm --filter server run migration:codegen`.

Webhook testing:
- Expose server via tunnel (e.g. ngrok) and set App webhook URL to `<APP_URL>/api/integrations/github/webhook`.
- Use real signature with `GITHUB_APP_WEBHOOK_SECRET`.

Error handling:
- Log per‑file failures; continue others; summarize in webhook event row.
- Backoff for 429; stop after capped retries; surface in UI.

Security:
- Only accept `X-Hub-Signature-256`.
- Keep Installation Token scope minimal (Contents: Read).
- Store private key securely; prefer secrets manager.

-------------------------------------------------------------------------------

## 14) Future (V2+)

- Two‑way sync: TipTap JSON → Markdown → PR (conflict strategy & authorship mapping).
- Precise asset update: `github_file_references (file_id, page_id, path)` to recompute affected pages.
- Queueing by default (BullMQ) with dedupe and retry policies.
- Large repo partitioning and incremental indexing improvements.
- “Edit on GitHub” and commit history links on pages.

-------------------------------------------------------------------------------

## 15) File Map (to be created/updated)

Backend — `apps/server/src/integrations/github/`
- `github.module.ts`
- `github.controller.ts`
- `github.webhook.controller.ts`
- `github.service.ts`
- `github.sync.service.ts`
- `github.link-rewriter.ts`
- `github.mapper.ts`
- `github.types.ts`

Migrations — `apps/server/src/database/migrations/2025XXXX_github.ts`

App wiring
- `apps/server/src/app.module.ts` — import `GithubModule`.
- `apps/server/src/main.ts:56` — add `/api/integrations/github/webhook` to excluded paths.

Frontend — `apps/client/src/features/integrations/github/`
- `pages/IntegrationsGithubPage.tsx`
- `components/GithubInstallCard.tsx`
- `components/RepoSelector.tsx`
- `components/SourceTable.tsx`
- `components/SyncStatusTag.tsx`
- `services/github-integration-api.ts`
- Add sidebar entry in `apps/client/src/components/settings/settings-sidebar.tsx:1`.

-------------------------------------------------------------------------------

## 16) Acceptance Checklist (MVP)

- [ ] Migrations applied and types generated; CRUD via Kysely verified.
- [ ] Full sync imports markdown + renders images/attachments with rewritten URLs.
- [ ] Push added/modified updates exactly one page; removed archives/deletes; renamed preserves page.
- [ ] UI: installations list, repo selection, source creation, rescan; statuses shown.
- [ ] Webhook validated via `X-Hub-Signature-256`; excluded path configured.
- [ ] ETag conditional requests reduce redundant content fetches.
- [ ] Smoke tested on multi‑repo setup within resource limits.

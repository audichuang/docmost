# Docmost

pnpm + nx monorepo:`apps/server`(NestJS/Fastify/Kysely)、`apps/client`(React/Mantine/Tiptap)、`packages/editor-ext`(前後端共用的 Tiptap 節點)。專案簡介見 README。

## 指令

```bash
pnpm dev                                            # client + server 同時起(需先有 Postgres + Redis)
pnpm --filter ./apps/server migration:latest        # 套用 DB migration
pnpm --filter ./apps/server migration:codegen       # 改完 schema 必跑,重生 db.d.ts
nx run server:build && nx run client:build          # 驗證改動的主要手段(見下方「沒有測試」)
```

secrets 放 `.env`(已 gitignore),需要哪些變數見 `.env.example`。`.env` 只對本機 dev 生效 —— `docker-compose.yml` 是逐個列舉 `environment:`,新變數沒一起補進去,容器裡就是讀不到,而且不會有任何錯誤。

## 這份 checkout 的定位

`main` 是上游 docmost v0.23.2(2025-09)的快照,不是最新版。查上游文件或 issue 時,先確認那個功能在這份 checkout 裡存不存在。

自製功能(GitHub repo 同步、Mermaid 縮放、R2 token 圖片)有**兩份實作**:`origin/dev` 是 v0.23 基底的舊版,現行的是 v0.95 基底的 `feat/rebuild-on-v095`(worktree `../docmost-v095`)。要動自製功能一律改後者。規格、未解問題與實測記錄在 `doc/`。

## 模組地圖

結構本身問 tree / codegraph,這裡只寫角色與跨模組關係。

**`apps/server/src/core/`** — 領域模型。租戶層次是 workspace(依 hostname 解析)→ space → page;page 是樹狀,`position` 是 fractional index **字串**不是整數。

**權限是雙層 CASL**(`core/casl/abilities/`):workspace 層 `UserRole`(OWNER/ADMIN/MEMBER)+ space 層 `SpaceRole`(ADMIN/WRITER/READER)。使用者的 space 角色可能來自直接成員**或**所屬 group,`space-member.repo.ts` 會 union 兩者再由 `findHighestUserSpaceRole()` 取最高。授權一律走 ability factory,別自己比對 role 字串。

**`database/repos/`** 放可重用查詢,但 service 也常直接 `@InjectKysely` 下 query — 兩種寫法並存,跟著鄰近檔案走。多筆寫入包在 `database/utils.ts` 的 `executeTx()` 裡。

**`collaboration/`** — Hocuspocus + Yjs。`extensions/persistence.extension.ts` 是頁面內容的正規落庫點(載入時 ydoc 缺就從 content 轉,存檔時一次寫 ydoc/content/textContent),`pnpm collab` 可用 `server/collab-main.ts` 獨立進程跑。

**`ws/`** 不是協作:是 socket.io gateway,只做 space room 廣播(頁面樹變動、通知)。文件內容不經過這裡。

**`integrations/queue/`** — BullMQ。queue 與 job 名稱集中在 `constants/queue.constants.ts`,名稱外面的 `{}` 是 Redis cluster hash tag,別拿掉。寄信、附件索引、backlinks、匯入匯出都是這裡的非同步工作。

**`integrations/static/`** — server 直接吐 `apps/client/dist`,所以正式部署是單一容器同時服務前後端。

**前端 feature-first**:`features/<domain>/{services,queries,components,hooks,types}`。`services/` 是打 API 的薄函式,`queries/` 是 TanStack Query hooks,元件只碰 queries。所有 HTTP 走 `lib/api-client.ts`(baseURL `/api`,interceptor 已把 `response.data` 攤平,所以呼叫端拿到的是 payload 不是 axios response;401 自動導登入)。路由集中在 `App.tsx`,`/share/*` 在 ShareLayout 下不需登入。

## 硬約束

**頁面內容有三份表示,不可只寫其中一份。** `pages` 表同時存 `content`(ProseMirror JSON)、`textContent`(全文搜尋用)、`ydoc`(Yjs binary)。從後端寫入頁面內容時三者要一起更新,只改 `content` 會讓協作編輯讀到舊的 ydoc。用 `common/helpers/prosemirror/utils.ts` 的 `createYdocFromJson()` / `getProsemirrorContent()`,別自己組。

**新增 Tiptap 節點要註冊三處**,少一處會靜默壞掉:
1. `packages/editor-ext/` — 節點定義
2. `apps/client/src/features/editor/extensions/extensions.ts` — `mainExtensions`
3. `apps/server/src/collaboration/collaboration.util.ts` — `tiptapExtensions`

漏掉第 3 處,編輯器看起來正常,但匯出 / 匯入 / 搜尋索引會把該節點吃掉。

**媒體 src 的最後改寫點是 `packages/editor-ext` 的 `normalizeFileUrl()`,不是 client 的 `getFileUrl()`。** image / video / audio / drawio / excalidraw 五種節點都走前者;`getFileUrl()` 只剩上傳中的 placeholder view 在用。要對媒體 URL 做全域改寫(加 token、換網域),掛在 `getFileUrl()` 上會靜默無效。

**所有 `/api/*` 路由預設要求已解析的 workspace。** `common/middlewares/domain.middleware.ts` 依 hostname 解出 `req.workspaceId`,`main.ts` 的 preHandler 對沒有 workspaceId 的請求直接丟 404 `Workspace not found`。真正 workspace 無關的新端點,必須加進 `main.ts` 的 `excludedPaths`。

**`apps/server/src/database/types/db.d.ts` 是 kysely-codegen 產生的**,不要手改;改 schema 走 migration 再 codegen。

## 授權邊界

- `apps/server/src/ee` 是私有 git submodule,**在這份 checkout 裡是空的,這是正常狀態** — 不要 init、不要在裡面補檔。OSS 程式碼不依賴它,能正常 build。
- `apps/client/src/ee`、`packages/ee` 在 repo 內但屬 Enterprise 授權(`packages/ee/License`)。別把 core 邏輯搬進去,也別把 EE 程式碼搬出來。

## i18n

只改 `apps/client/public/locales/en-US/translation.json`。其他 12 個語系由 Crowdin 同步回來(`crowdin.yml`),手動編輯會被覆蓋。

## 沒有測試

`main` 的 `*.spec.ts` 全是 NestJS scaffolding 殘留(只有 `should be defined`),`pnpm test` 通過不代表任何事。`feat/rebuild-on-v095` 的 `integrations/github/` 底下才有真測試。

**build 與 typecheck 通過也不代表功能有接上。** 已經發生過兩次:授權檢查要求的欄位,跟寫入端刻意留空的欄位對不上;URL 改寫掛在上游改版後已經沒人呼叫的函式上。兩邊都是合法程式碼,只是沒有人呼叫,所以靜態檢查一路綠燈。會影響執行結果的改動,要實際跑起來操作驗證。

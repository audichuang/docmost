# Fork 功能重做規格

目標:把 `origin/dev` 的 20 個自製 commit,在上游 **v0.95.0** 上重新實作。

本文件是規格不是 patch。dev 的舊實作只當參考,凡與 v0.95 的既有機制衝突,以本文的新做法為準。

## 實作狀態

分支 `feat/rebuild-on-v095`(worktree:`../docmost-v095`),6 個 commit,51 檔 / +5828 行。

| ID | 功能 | 狀態 |
|---|---|---|
| F1 | GitHub 內容同步 | ✅ 實測通過(P1 圖片全 404 已修,`3afb3852`) |
| F2 | R2 圖片 token | ✅ 實測通過(P2 token 從未接上已修,`3afb3852`) |
| F3 | 協作載入穩定性 | ⚠️ 鎖定頁前後端都已唯讀、IndexedDB 幻影已修(P4);其餘穩定性項目仍待實測 |
| F4 | Mermaid 全螢幕縮放 | ✅ 完成並實測通過 |
| F5 | 用 URL 插入圖片 | ✅ 完成(非圖片 URL 無提示是刻意的,見 P5) |
| F6 | CI/CD 到 k3s | ✅ 完成 |

**2026-08-02 起,本表反映的是實際跑起來的結果,不再只是 build 通過。** 完整測試記錄、發現的問題與修復複驗見 [`deploy-test-20260802.md`](./deploy-test-20260802.md)。P1–P5 的編號對應該文件。

審查後修正的問題(原 §0.35 A/B/C 組)已全數處理,見 commit `918f65f5` 及其前四個。

驗證:server + client `tsc --noEmit` 皆通過、`nest build` 與 `vite build` 皆成功、測試 245 個中 231 通過。失敗的 14 個在 pristine v0.95 上完全相同(NestJS scaffolding stub),與本次改動無關。

**尚未做的**:~~實際跑起來測~~(2026-08-02 已完成,見 `deploy-test-20260802.md`)、`migration:codegen`(`db.d.ts` 是手動補的,跑一次 codegen 就會對齊)、i18n 新字串進 `en-US/translation.json`(缺的話 i18next 會 fallback 成英文 key,不影響功能)。

**實測抓到、build 與 typecheck 抓不到的四個缺陷**(兩邊都是合法程式碼、只是沒人呼叫),已於 `3afb3852` 修復並在同一台機器複驗:

| # | 問題 | 修法 |
|---|---|---|
| P1 | 同步 attachment 的 `page_id` 從未回填(§F1.5 第 9 點指定要做),而 `attachment.controller.ts` 硬性要求 `pageId` 非空 → 同步圖片全部 404 | 改成 space 層授權,**不採用回填** —— 回填會讓多頁共用的圖只能綁一頁 |
| P2 | `appendR2Token` 掛在 `getFileUrl()`,但 v0.95 的 node view 走 `editor-ext` 的 `normalizeFileUrl()` → token 從未接上;`drawio`/`audio`/`excalidraw`/`video` 同樣受影響 | `media-utils.ts` 加 module-level transformer,一次涵蓋 9 個呼叫點 |
| P3 | 沒有 README 的資料夾頁從未被鎖(§0.35 B2 第三項) | `ensureFolderChain` 建立時鎖定,並每次同步 reconcile |
| P4 | 鎖定頁前端仍可打字,IndexedDB 每次載入重播 → 靜默資料遺失 | `canEdit` 納入 `!isLocked`,鎖定頁跳過 `IndexeddbPersistence` |

**操作者必須設定**:GitHub App 要開啟「Request user authorization (OAuth) during installation」並設定 `GITHUB_APP_CLIENT_SECRET`,否則 installation 連結會被直接拒絕(這是刻意的 fail-closed 行為,不是 bug)。

### 兜底審查後仍未修的項目

Codex 對「修正本身」做了第二輪審查,以下是確認仍開著的。全部都不影響一般使用,但上 production 前該有決定。

| # | 問題 | 嚴重度 |
|---|---|---|
| 1 | `GET /user/installations` 列的是使用者**有 repo 存取權**的 installation,不是他管理的。組織裡看得到一個 repo 的協作者,就能把該組織的 installation 綁進自己的 workspace。要真正證明管理權需要另一套檢查(或接受此殘留並靠 workspace admin 限制)。另外分頁硬上限 5 頁,持有超過 500 個 installation 的使用者會被誤拒 | 高 |
| 2 | `isLocked` 只擋被點名的那一頁:trash 和 move-to-space 檢查根節點後就遞迴處理子孫;第二個 source 可以掛到另一個 source 的鎖定頁上,再經由 direct-connection 覆寫它;transclusion unsync 會在 socket 寫入被拒之前就複製附件、刪掉 reference。EE 路徑因 submodule 未初始化無法檢查 | 高 |
| 3 | `assertContentPersisted` 比 `textContent`:只改格式/屬性/連結/圖片 URL 的變更、以及空白或無文字的頁面,落庫失敗驗不出來;舊資料 `textContent` 為 null 反而會誤判失敗。資料夾 README 的 reset 路徑完全沒有這道驗證 | 高 |
| 4 | Redis 鎖續約失敗只是回 false,節點**不會卸載文件**,仍繼續服務本地 socket → A、B 兩節點同時接受寫入 | 高 |
| 5 | advisory lock 只保證互斥、不保證**順序**:較新的「重新加入檔案」push 可能先拿到鎖,被延後的較舊「刪除檔案」push 隨後執行並刪掉最新內容 | 高 |
| 6 | 同一個 lock 交易會釘住一條連線,而同步本體是用 `this.db`(另一條連線)。`DATABASE_MAX_POOL=1` 會直接死鎖;夠多平行 worker 也能耗盡較大的 pool | 中 |
| 7 | 全量同步的 coalescing 忽略 `force`:強制重掃若撞上進行中的非 force job,會被靜默併入後者 | 中 |
| 8 | `rootDir` 過濾發生在抓完整棵 tree 之後,所以大型 repo 的一個小子目錄同樣會因 truncated 而永久無法同步,且沒有繞道 | 中 |
| 9 | 附件的 `attachments` insert 與 `githubFiles` mapping 仍是兩個獨立操作(不在 `executeTx` 內);升級前用隨機 id 建立的附件,在第一次改寫時會變成孤兒 | 中 |

### 已知殘留風險

| 風險 | 說明 |
|---|---|
| 超大 repo 無法同步 | tree truncated 現在直接讓 job 失敗。需縮小 `rootDir`,或之後補非遞迴走訪 |
| DB 連線佔用 | per-source 的 advisory lock 會佔住一條連線直到同步結束(`DATABASE_MAX_POOL` 預設 10) |
| storage 上傳不回滾 | 附件的 DB 步驟有交易保護,但已上傳的物件不會清除(沒有分散式交易) |
| hard kill 窗口 | `pageService.create()` 成功後、補償邏輯執行前被強殺,會留下空白鎖定頁 |
| 落庫驗證的盲點 | `assertContentPersisted` 比對 `textContent`。只改格式不改文字的變更,若落庫失敗驗不出來 |

---

## 0. 前提

### 0.1 升級順序(不可跳)

| # | 動作 | 說明 |
|---|---|---|
| 1 | `main` fast-forward 到上游 | 本地 main 是純快照,無本地 commit,可直接 ff |
| 2 | 基礎設施先到位 | Postgres 16→**18**(跨 major,要 dump/restore;volume 掛載點改成 `/var/lib/postgresql`)、Redis 7.2→**8**、Node 22→**26**、pnpm→11.15 |
| 3 | 跑上游 20 個新 migration | 見 0.2 的順序陷阱 |
| 4 | 逐功能重做(第 9 節排序) | 每個功能獨立 PR |

### 0.2 Migration 時間戳陷阱

上游新增的 `20250912T101500-api-keys.ts` 時間戳**早於** dev 的 `20251001T130000-github.ts`。正式 DB 已經跑過 github migration,而 `apps/server/src/database/migrate.ts` 的 Migrator 沒開 `allowUnorderedMigrations`,Kysely 會判定 corrupted migrations 直接拋錯。

**做法**:重做時把 GitHub 的 4 個 migration 合併成 **1 個**,時間戳取 `2026-08` 之後。反正正式環境要重建 schema,沒有保留 4 段歷史的價值。

### 0.3 這次一併修掉的既有缺陷

| 位置 | 問題 |
|---|---|
| `r2-token.controller.ts` | `@Controller('api/r2-token')` 在 global prefix `api` 之下 → 實際路徑是 `/api/api/r2-token`;且是無授權的 test 端點。**整個刪掉** |
| `r2-token.service.ts` | secret 放在 query string(`?secret=xxx`)呼叫外部 API,會進 access log。改走 header |
| `R2_IMAGE_TOKEN_SETUP.md` | 文件寫「本地 HMAC 簽章」,實作是「打外部 API 拿 token」。文件與程式碼不符 |
| github / r2 服務 | 大量 `console.log` 與 emoji log、逐檔 `[R2 Transform]` info log。降為 `debug` |
| repo 根目錄 | `GITHUB_INTEGRATION_SETUP.md`、`R2_IMAGE_TOKEN_SETUP.md`、`github_plan.md`、`github_pr.md` 散在 root。收進 `doc/` |
| `github_pr.md` | 是**未實作**的 PR 雙向同步設計稿(無對應 migration)。不要當成現況,見 F1.9 |

---

## 0.35 審查未解項目

自查 + Codex 深度審查後仍未修的問題,依嚴重度排序。**上線前至少要處理 A 組。**

### A 組 — 會造成資料遺失或錯誤鏡像

| # | 問題 | 位置 |
|---|---|---|
| A1 | `COLLAB_DISABLE_REDIS=true` 時 `handleYjsEvent()` 回傳 `undefined`(`redisSync?.` optional chaining),**完全沒寫入**,但同步照樣把該檔標記 synced 並記下 SHA → 頁面永遠空白且不會重試 | `collaboration.gateway.ts:143`、`github-sync.service.ts` |
| A2 | 同理,`onStoreDocument` 的 DB transaction 失敗時被 catch 吞掉,Hocuspocus 視為成功,同步仍推進 mapping | `persistence.extension.ts` |
| A3 | webhook 增量同步傳入空的 `blobShas`,**相對路徑圖片會退回未解析的相對 URL**;新增/改名的資產也匯不進來 | `github-sync.service.ts` `applyPushToSource` |
| A4 | 刪除某目錄的 `README.md` 會對整個資料夾頁呼叫遞迴 `removePage()`,**連帶把未變動的子頁全部丟進垃圾桶**;mapping 仍是 synced,之後的 SHA 快捷比對會一直跳過它們 | `github-sync.service.ts` `deleteMapping` |
| A5 | GitHub compare API 單次最多回 300 個變更檔;超過就靜默只處理 300 個仍標記成功。tree truncated 時也只 log warning 卻清掉 `lastSyncError` | `github-api.service.ts`、`github-sync.service.ts` |
| A6 | 同一 source 的 job 沒有序列化:全量掃描與 push 可並行,舊 commit 的內容可能後寫入並記下新 SHA | `github.processor.ts` |

### B 組 — 授權與正確性

| # | 問題 |
|---|---|
| B1 | callback 的 state 已簽章,但攻擊者仍可用**自己 workspace 的合法 state** 搭配**別人的 `installation_id`**,把受害者的 installation 綁進自己的 workspace 進而讀取其私有 repo。真正的修法是走 GitHub App 的 user-to-server OAuth,用 `code` 換 user token 後呼叫 `GET /user/installations` 確認呼叫者確實擁有該 installation;另外 `installation_id` 應改成全域唯一 |
| B2 | ~~`isLocked` 只在 WebSocket authenticate 時生效。REST 仍可改標題/內容、搬移、丟垃圾桶~~ → **REST 部分已由 `b2ee9d46` 修好**,2026-08-02 實測 `update`/`move`/`move-to-space`/`delete` 四條全 403。**仍開著**:鎖定前已建立的連線還能寫(未測);沒有 README 的純結構資料夾頁根本沒被鎖(**已實測發生**,見 `deploy-test-20260802.md` P3 —— 11 個資料夾頁裡 2 個沒鎖,底下各有鎖定子頁) |
| B3 | webhook 冪等只保證「不重複處理」,不保證「一定被處理」:event row 已 commit 但 `queue.add()` 前程序死掉,GitHub 重送會撞 unique 而被當成功 → 該次推送永久遺失。需要 outbox/replayer 或用 delivery-id 當確定性 job id |
| B4 | 改名的檔案 mapping 路徑會更新,但 `parentPageId` 沒跟著改 → 頁面留在舊資料夾底下 |
| B5 | 每檔失敗被 catch 後 job 仍標記成功、BullMQ 不重試;`removePage` 失敗仍把 mapping 標成 deleted → 之後永遠不再嘗試刪除 |
| B6 | 建頁與建附件非原子:頁面先建立才寫內容與 mapping,storage 物件先上傳才寫唯一 mapping → 中途失敗會留下空白鎖定頁、孤兒 attachment 或孤兒 storage 物件 |
| B7 | 長時間同步可能撐過 installation token 的 1 小時效期(目前只在取得時快取,不會在中途換發) |

### C 組 — 上游既有問題(不是這次改的,但同步依賴它)

| # | 問題 |
|---|---|
| C1 | `redis-sync.extension.ts` 的文件鎖續約是無條件 `SET`、釋放是無條件 `DEL`。節點 A 逾時後 B 取得鎖,A 恢復仍可覆寫或刪除 B 的鎖 → 並行寫入變成 last-writer-wins。應改用 ownership token + Lua 的 compare-and-delete |

### 待確認

`/api/r2/token` 是公開端點。**需要確認 Worker 的 token 作用域**:若該 token 授權整個網域,任何人都能取得後直連所有已知物件 URL,而不只是公開分享頁上的圖片。若是全域作用域,應改成綁 share/path 或要求授權。

## 0.4 實作與本規格的差異

實作時發現 v0.95 已有更好的原語,以下幾處比規格寫的更簡單或更強:

| 項目 | 規格原本寫 | 實際做法 | 為什麼 |
|---|---|---|---|
| 頁面內容寫入 | 自己呼叫 `openDirectConnection` | 直接用 `PageService.updatePageContent()` | 它內部就是 `handleYjsEvent` → Redis → `withYdocConnection`,已經是叢集安全的 |
| 唯讀鎖 | 在 `onStoreDocument` 擋 `isLocked` | 在 `authentication.extension.ts` 設 `connectionConfig.readOnly` | 擋 `onStoreDocument` 會連同步自己的寫入一起擋掉;direct connection 不經過 authenticate,所以同步照樣能寫 |
| 同步進度 | SSE | BullMQ job progress + 前端輪詢 | 進度存在 Redis,任何節點都讀得到,不用額外 pub/sub |
| 附件改寫 | 移植 257 行 link-rewriter | ~180 行,直接用 `StorageService` + `attachments` | 另外加了 blob sha 比對:沒變的圖不重傳,推送時就地更新既有 attachment 的位元組 |
| Mermaid 縮放 | `react-zoom-pan-pinch` | CSS transform + pointer 事件 | fork 每多一個依賴,之後每次跟上游合併都要扛 |
| Migration | 4 個檔 | 合併成 1 個,時間戳 `20260810` | 順帶加了 `attachment_id` / `last_sync_error` / `last_synced_at` / `error`,讓失敗在 UI 上看得到 |

**F2 的方案由我代選了 B(前端接 token)**:Worker 契約完全不用改,文件內容保持乾淨。若你偏好 A(簽章 cookie),`lib/r2-token.ts` 與 `r2-token.service.ts` 兩個檔換掉即可,其餘不受影響。

**仍未實作**:markdown 內指向其他 `.md` 的相對連結不會改寫成 Docmost 頁面連結(dev 版也沒有)。需要全量掃完建好 path→pageId 後再跑第二輪。

## 1. 功能總表

| ID | 功能 | 規模 | 與 v0.95 衝突 | 優先序 |
|---|---|---|---|---|
| F1 | GitHub 內容同步 | 大(~2600 行) | 中(多為新檔) | P0 |
| F2 | R2 圖片 token 保護 | 中 | **高**(架構要換) | P1 |
| F3 | 協作載入穩定性 | 中 | **高**(hocuspocus v4) | P1 |
| F4 | Mermaid 全螢幕縮放 | 小 | 低 | P2 |
| F5 | 用 URL 插入圖片 | 小 | 低 | P2 |
| F6 | CI/CD 到 k3s | 小 | 無 | P0(先做,後面才有得測) |

---

## F1. GitHub 內容同步

### F1.1 目的

把 GitHub repo 的 markdown 當**唯讀來源**同步進 Docmost space:repo 目錄結構 → 頁面樹,`.md`/`.mdx` → 頁面,相對路徑圖片 → Docmost attachment。push 後由 webhook 自動更新。

一個 space 可掛多個 source(不同 repo / 不同 branch / 不同子目錄)。

### F1.2 資料模型

四張表,**合併為單一 migration**,全部帶 `workspace_id` 或可經 source 追到 workspace。

**`github_installations`** — 一個 GitHub App installation 綁一個 workspace
```
id uuid pk (gen_uuid_v7)
workspace_id uuid → workspaces cascade, not null
app_id varchar not null
installation_id varchar not null          -- GitHub 的數字 ID
account_login varchar not null
account_type varchar not null             -- CHECK in ('User','Organization')
created_at / updated_at timestamptz
UNIQUE (workspace_id, installation_id)
```

**`github_sources`** — 一條同步設定
```
id uuid pk
workspace_id uuid → workspaces cascade, not null
space_id uuid → spaces cascade, not null
github_installation_id uuid → github_installations cascade, not null
owner / repo / ref varchar not null       -- ref = branch/tag/sha
root_dir varchar not null default ''      -- 只同步 repo 的這個子目錄
target_path varchar(500) not null default ''  -- 掛在 space 內的哪個路徑下
root_page_id uuid → pages set null
mode varchar not null default 'readonly'
active boolean not null default true
last_full_scan_sha varchar
created_at / updated_at timestamptz
UNIQUE (space_id, owner, repo, ref, root_dir)
INDEX (github_installation_id), (workspace_id, updated_at)
```

**`github_files`** — 檔案 ↔ 頁面對照表
```
id uuid pk
source_id uuid → github_sources cascade, not null
path text not null                        -- repo 內相對路徑;資料夾用結尾斜線
content_type varchar not null             -- CHECK in ('markdown','asset','folder')
page_id uuid → pages set null
sha / etag varchar                        -- 增量判斷用
title text
status varchar not null default 'synced'  -- CHECK in ('synced','deleted','error')
renamed_from_path text
created_at / updated_at timestamptz
UNIQUE (source_id, path)
INDEX (source_id, sha), (source_id, updated_at)
```

**`github_webhook_events`** — 冪等 + 稽核
```
id uuid pk
github_installation_id uuid → github_installations set null
delivery_id varchar not null UNIQUE       -- GitHub 的 X-GitHub-Delivery,用來去重
event varchar not null
repo_full_name / before_sha / after_sha varchar
files_json jsonb
processed boolean not null default false
processed_at timestamptz
ok boolean
error text
created_at timestamptz
INDEX (created_at)
```

> 冪等靠 `delivery_id` 的 unique constraint:插入衝突就代表重複投遞,直接跳過。

### F1.3 環境變數

```bash
GITHUB_APP_ID=
GITHUB_APP_SLUG=                 # App 的 URL 名稱,不是 display name
GITHUB_APP_CLIENT_ID=
GITHUB_APP_PRIVATE_KEY=          # PEM,需保留換行
GITHUB_APP_WEBHOOK_SECRET=
GITHUB_API_BASE=https://api.github.com
GITHUB_API_VERSION=2022-11-28
```

GitHub App 設定:Callback URL `{APP_URL}/api/integrations/github/callback`、Webhook URL `{APP_URL}/api/integrations/github/webhook`、權限 Contents + Metadata 皆 read-only、訂閱 Push / Installation / Installation repositories 三個事件。

### F1.4 API

前綴 `/api/integrations/github`,除註明外都要登入(JwtAuthGuard)。

| Method | Path | 說明 |
|---|---|---|
| GET | `/installations` | 列出本 workspace 已連結的 installation |
| POST | `/installations/sync` | 從 GitHub 反向同步 installation 清單 |
| GET | `/installations/auth-url` | 回傳 GitHub 安裝頁 URL,`state` 帶 base64 的 workspaceId |
| GET | `/callback` | **Public + SkipTransform**。驗 state → 連結 installation → 302 回前端帶 `?success=true` 或 `?error=<code>` |
| DELETE | `/installations/:id` | 解除連結 |
| GET | `/repos?githubInstallationId=` | 該 installation 可存取的 repo |
| GET | `/refs?githubInstallationId=&owner=&repo=` | branch + tag 清單 |
| POST | `/sources` | 建立 source 並**背景**啟動全量同步,立即回 `{ jobId }` |
| GET(SSE) | `/sources/progress/:jobId` | 同步進度事件流 |
| GET | `/sources` | 列出本 workspace 的 source |
| POST | `/sources/:id/rescan?force=1` | 手動重掃 |
| PATCH | `/sources/:id` | 目前只切 `active` |
| DELETE | `/sources/:id` | 刪除 source |
| POST | `/webhook` | **Public**。獨立 controller,驗 HMAC 簽章 |

**權限**:凡涉及 space 的操作(建立 / 重掃 / 更新 / 刪除 source),都要 `SpaceAbilityFactory` 檢查 `SpaceCaslAction.Edit / SpaceCaslSubject.Page`。

> **v0.95 新增要求**:v0.95 有頁面級權限(`page_access` / `page_permissions` 兩張表)。同步寫入頁面時除了 space 層,還要確認不會繞過頁面層限制。這是 dev 版沒有的檢查。

**SSE 進度事件**
```ts
type SyncProgressEvent = {
  jobId: string;
  type: 'init' | 'fetching_tree' | 'tree_fetched' | 'syncing_files'
      | 'file_synced' | 'completed' | 'error';
  message: string;
  progress?: { current: number; total: number };
  data?: any;
};
```
小 repo 每檔發一次,大 repo 每 5 檔發一次。

> **v0.95 要改**:dev 版用 `setImmediate()` 在 request 進程裡跑同步、進度靠記憶體 `rxjs.Subject`。多副本部署下 SSE 會連到沒有該 job 的 pod。**改用 BullMQ**:新增 `GITHUB_QUEUE` 與 `github-full-sync` job,進度寫 Redis,SSE 從 Redis 讀。v0.95 的 file-tasks(匯入匯出)就是這個模式,照抄。

### F1.5 全量同步規則

1. 取 installation token → `GET /repos/{owner}/{repo}/git/trees/{ref}?recursive=1`
2. 過濾:非 `.md`/`.mdx` 跳過;`root_dir` 之外跳過
3. 對每個檔案抓內容,帶 **ETag**;`304` 代表未變 → 只更新掃描時間就跳過
4. `markdown → HTML`(`markdownToHtml`)→ **link rewrite**(見 F1.6)→ `HTML → TipTap JSON`(`importService.processHTML`)
5. 標題:`extractTitleAndRemoveHeading()` 取首個 H1 當頁面標題並從內文移除
6. **資料夾映射**:`ensureFolderChain()` 依相對目錄建立資料夾頁,repo 目錄結構 = 頁面樹。資料夾頁在 `github_files` 以 `content_type='folder'`、path 帶結尾斜線記錄
7. **README/index 特例**:目錄下的 `README.md` / `index.md` 不另開頁,內容直接寫進該資料夾頁;同時把真實檔案路徑也 upsert 一筆對照,保留可追溯性
8. 既有對照 → `updatePage()` 並修正 parent;無對照 → `insertPage()`,position 由 `nextPagePosition()` 算
9. 附件:rewrite 階段先建立無 pageId 的 attachment,頁面建好後回填 `page_id`
10. 收尾:寫 `last_full_scan_sha` = 當前 head sha

**作者**:同步產生的頁面 `creatorId` / `lastUpdatedById` 用 workspace 的預設使用者(`getDefaultWorkspaceUserId()`)。

**唯讀鎖**:`mode='readonly'` 的 source 產生的頁面設 `is_locked=true`,並在 collab 端擋掉寫入(F1.8)。

### F1.6 Link rewrite

`GithubLinkRewriter.rewriteHtml()`:
- 把相對路徑的圖片/附件抓下來、上傳到 Docmost storage、建立 attachment、把 HTML 內的 src 換成 Docmost 附件 URL
- 大小上限 50 MB
- 回傳改寫後 HTML + 建立的 attachmentIds

### F1.7 Webhook 增量同步

```
POST /webhook
  → 驗 X-Hub-Signature-256(HMAC-SHA256,固定時間比較,長度先檢查)
  → 依 X-GitHub-Delivery 寫 github_webhook_events;衝突 = 重複投遞,直接結束
  → event=push:
      ref → branch 名,找出 (owner, repo, ref) 相符且 active 的 sources
      用 Compare API (before...after) 取變更清單
      逐檔:
        removed  → 對照標記 deleted + 頁面軟刪除(pageRepo.removePage)
        renamed  → 更新對照的 path;舊路徑若在 root_dir 之外則跳過
        added/modified/renamed → 強制重抓內容(push 時不信 ETag)→ 同 F1.5 步驟 4-9
  → event=installation / installation_repositories → 同步 installation 狀態
  → 寫回 processed / ok / error / processed_at
```

### F1.8 頁面寫入與協作的互動 ← **v0.95 最大改動點**

dev 版的做法是:更新 DB 後呼叫自己加的 `collaborationGateway.closeDocumentConnections('page.<id>')`,**踢掉所有連線**逼 Yjs 文件重新從 DB 載入。使用者體驗是頁面突然斷線。

v0.95 的 `CollaborationGateway` 已經提供更好的原語(已確認存在):

```ts
openDirectConnection(documentName, context?)   // 直接拿到伺服器端的 Y.Doc
lockDocument(documentName)                      // Redis 分散式鎖
releaseLock(documentName)
```

**新做法**:
```
lockDocument('page.<id>')
  → openDirectConnection('page.<id>')
  → 在 transact 內把新內容套進 Y.Doc(不是覆寫 DB)
  → 關閉 direct connection(persistence extension 自然落庫)
releaseLock()
```
好處:正在看該頁的人即時看到更新、不斷線、不會有 `ydoc` 與 `content` 不同步的風險。

**唯讀鎖**:`PersistenceExtension.onStoreDocument` 要在 `page.isLocked` 時直接 return,擋掉使用者對 GitHub 頁面的編輯。已確認 **v0.95 仍未做這件事**(`apps/server/src/collaboration/` 與 `core/page/` 內查無 `isLocked`),所以這段仍要自己加。

### F1.9 明確**不做**的範圍

`github_pr.md` 描述的「Docmost 編輯 → 產生 GitHub PR」雙向流程**沒有實作過**(無 `github_edit_sessions` 表)。這次一樣不做。若之後要做,那份設計稿裡的競態分析仍然有效,但要重寫在 v0.95 的 `openDirectConnection` + `lockDocument` 之上。

### F1.10 前端

`apps/client/src/features/integrations/github/`,掛在 `/settings/integrations/github`。

> v0.95 **沒有** `features/integrations` 這一層,也沒有 integrations 設定路由。要自己在 `App.tsx` 與 settings sidebar 加,照 `pages/settings/shares` 的既有寫法。

| 元件 | 職責 |
|---|---|
| `IntegrationsGithubPage` | 頁面外框,處理 callback 回來的 `?success` / `?error` 並跳通知 |
| `GithubInstallCard` | 「Connect GitHub」按鈕、已連結 installation 清單、Refresh |
| `RepoSelector` | 選 installation → repo → ref → root dir → 目標 space → target path |
| `SourceTable` | source 清單、Rescan / 啟停 / 刪除 |
| `SyncProgressModal` | 訂閱 SSE,顯示進度條與目前檔案 |
| `SyncStatusTag` | 狀態小標籤 |

服務層照 v0.95 慣例拆 `services/`(打 API)+ `queries/`(TanStack Query hook),元件只碰 queries — dev 版只有 `services/`,重做時補上。

### F1.11 驗收條件

2026-08-02 實測結果(`deploy-test-20260802.md`):

- [x] 連結 GitHub App → 選 repo/branch/子目錄 → 建立 source,進度跑完 —— 135 md / 11 folder / 37 asset,零錯誤
- [x] repo 的巢狀目錄在 Docmost 呈現為對應的頁面樹
- [x] 目錄下的 `README.md` 內容出現在該資料夾頁本身,沒有多一頁
- [x] markdown 內相對路徑圖片變成 Docmost attachment 且顯示正常 —— P1 修復後複驗 21/21 載入
- [x] push 一次 commit → webhook 後變更正確反映 —— 新增 / 修改 / 刪除三種已測(**改名未測**);1 秒觸發、4 秒完成,增量精準(182 個未變動檔沒被 touch)
- [ ] 同一個 webhook 重送兩次,只處理一次 —— 未測
- [ ] 有人正開著該頁時 push,頁面內容即時更新且**不斷線** —— 未測
- [x] 對 `readonly` source 的頁面打字,內容不會被存進 DB —— P4 修復後前端也唯讀,且不再建立 IndexedDB store
- [ ] 無該 space 編輯權的使用者呼叫 source API 得到 403 —— 未測(只有一個使用者)
- [ ] 刪除 source → 對照清掉,頁面依設定保留或軟刪除 —— 未測

---

## F2. R2 圖片 Token 保護

### F2.1 目的

R2 自訂網域上的圖片不希望被匿名直連,只有經 Docmost 發出的頁面內容才帶得出可用的圖片 URL。

### F2.2 現況實作與它的根本問題

dev 版在 `PersistenceExtension.onLoadDocument` 把整份文件 JSON 字串化,用 regex 把所有 R2 網域的 URL 加上 `?token=...`,再轉回 Y.Doc 回傳。

**這是錯的地方**:被改過的 URL 進了 Y.Doc,而 Y.Doc 會經 `onStoreDocument` 落庫。等於把 **5 分鐘後就失效的 token 寫進 `pages.content` / `pages.ydoc`**。dev 版的 `appendTokenToUrls()` 每次載入都要先把舊 token 剝掉再貼新的,就是在補這個洞。副作用還有:每次載入多一輪 fromYdoc/toYdoc、多人協作時不同 client 拿到不同 token 版本的內容。

`fix(collab): skip R2 token transformation for locked pages` 這個 commit 也是同一個洞的補丁。

### F2.3 重做:token 不要進文件

按優先序擇一:

**方案 A(建議)— 簽章 cookie**
Cloudflare Worker 改收 cookie 而非 query token。Docmost 在使用者載入頁面時,對 R2 網域下發一個短效簽章 cookie(`Domain=<r2-domain>; HttpOnly; Secure; SameSite=None`)。文件內容完全不動,圖片請求自動帶 cookie。

**方案 B — 前端出手**
文件裡存乾淨 URL,前端 image node 在 render 時才把 token 接上去。token 由 `GET /api/attachments/r2-token` 取得並在前端快取。文件內容仍然乾淨。

**方案 C — 維持後端改寫,但改位置**
真的要後端改寫,就**不能在 collab 路徑做**。改在 REST 回應的出口(`POST /api/pages/info`、`/api/pages/history/info`、`/api/shares/page-info`)—— 這些回應不會回寫 DB。代價:協作編輯器走 WebSocket 拿內容,這條路就保護不到。

> 這是唯一需要你先拍板的決策點。A 最乾淨但要動 Worker;C 最省事但保護不完整。

### F2.4 不論選哪案都要做

- token 快取改放 **Redis**(現在是行程內記憶體,多副本各要各的)
- secret 改用 header 傳,不要放 query string
- 刪掉 `r2-token.controller.ts`(路徑 bug + 無授權)
- 逐頁面的 info log 降成 debug
- 未設定 `R2_IMAGE_DOMAIN` 時整條功能靜默停用(現行行為,保留)

環境變數維持:`R2_IMAGE_DOMAIN`、`R2_TOKEN_SECRET`(未設則沿用 `APP_SECRET`)、`R2_TOKEN_VALIDITY_SECONDS`(預設 300)。

### F2.5 驗收條件

2026-08-02 實測:**整組原本卡在 P2**(token 掛在 v0.95 已不使用的渲染路徑),`3afb3852` 修復後複驗:

- [x] render 出來的 R2 網域 URL 帶 `?token=`,非 R2 網域的 URL 原封不動
- [x] 編輯頁面存檔後,DB 的 `pages.content` 內**找不到** `token=` 字串 —— token 只在 render 時接上,不進內容
- [ ] token 過期後重新載入頁面,圖片仍正常顯示 —— 未測(需等 5 分鐘過期窗)
- [ ] `R2_IMAGE_DOMAIN` 沒設時,一切照舊、沒有額外請求 —— 未測
- [ ] 直連無憑證 401 —— 未測(Worker 端行為,不在 Docmost)

---

## F3. 協作載入穩定性

### F3.1 dev 版做了什麼

`page-editor.tsx` 的一組修補:

| 改動 | 原因 |
|---|---|
| `ydoc` 改成 `useMemo(() => new Y.Doc(), [pageId])` | 原本 `useRef` 跨頁面共用同一個 Y.Doc |
| 換頁時重設所有連線狀態 | 舊狀態殘留導致誤判已同步 |
| locked 頁面**跳過** IndexedDB persistence | 避免 GitHub 頁面吃到過期的本機快取 |
| 內容備妥前顯示 `EditorSkeleton` | 原本先渲染靜態內容再抽換,會閃 |
| 連線逾時累計 + `connectionError` 狀態 | 連不上時給明確錯誤而不是一直轉 |
| `disconnect` 時若從未連上成功,重設 `isRemoteSynced` | 誤判成已同步 |

### F3.2 重做原則:先確認問題還在

v0.95 **升級到 hocuspocus v4** 且 `page-editor.tsx` 被改了 +242/−172 行。上面六項有一半可能已經在上游修掉了。

**做法**:先在 v0.95 上照原本的重現步驟各測一次(快速切換頁面、離線開頁、斷網重連、開 GitHub 唯讀頁),只補**實測仍存在**的問題。不要整段 port 過去。

唯一確定仍需要的是「locked 頁面跳過 IndexedDB」—— 因為 F1 的唯讀頁面概念是自製的,上游不會有。

### F3.3 驗收條件

- [ ] 連續快速切換 5 個頁面,不會出現 A 頁內容顯示在 B 頁
- [ ] 斷網後重連,編輯器恢復可編輯且無內容遺失
- [ ] 後端關閉時開頁面,顯示明確錯誤而非無限 loading
- [ ] GitHub 唯讀頁在 repo 更新後重開,顯示的是新內容(非 IndexedDB 舊快取)

---

## F4. Mermaid 全螢幕縮放

### F4.1 規格

Mermaid 圖表右上角加「放大」按鈕,開 Modal 全螢幕檢視:

- `react-zoom-pan-pinch` 提供縮放/平移(**新依賴**,確認 v0.95 沒有同類套件再裝)
- 開啟時自動計算縮放:圖表佔 viewport 90%,`Math.min(scaleX, scaleY, 10)` 取上限 10x
- 浮動工具列:放大 / 縮小 / 重設 / 關閉,按鈕帶 i18n tooltip
- Esc 關閉

檔案:`features/editor/components/code-block/mermaid-zoom-modal.tsx`(新檔),`mermaid-view.tsx` 只加觸發按鈕。

> v0.95 對 `mermaid-view.tsx` 只動了 +2/−1,這個功能幾乎無痛移植。

### F4.2 驗收條件

- [ ] 大圖表放大後可讀、可拖曳平移
- [ ] 小圖表不會被放大到失真
- [ ] Esc 與關閉鈕都能關,關閉後頁面捲動位置不變

---

## F5. 用 URL 插入圖片

Slash menu 新增「Image from URL」項目:輸入圖片 URL → 插入 image node。95 行,只動 `slash-menu/menu-items`(dev 版順手把副檔名從 `.ts` 改成 `.tsx`,因為要放 JSX)。

**驗收**:貼一個公開圖片 URL 能插入並顯示;非圖片 URL 給錯誤提示;URL 需經 `@braintree/sanitize-url`(專案已有此依賴)。

---

## F6. CI/CD 到 k3s

### F6.1 規格

`.github/workflows/docker-build.yml`,push 到 `dev` 或手動觸發:

**CI job** — QEMU + Buildx → 登入 Docker Hub → build/push,tag 為 `latest`、`dev`、`dev-<sha>`;registry buildcache。
**CD job** — `needs: ci`,POST 到 `${K8S_MANAGER_URL}/api/webhook/deploy`,帶 service/namespace/deployment/version/commitSha,依 HTTP 狀態碼決定成敗。

Secrets:`DOCKERHUB_USERNAME`、`DOCKERHUB_TOKEN`、`K8S_MANAGER_URL`、`WEBHOOK_TOKEN`。

### F6.2 重做時要改的

- **平台**:workflow 的 env 寫 `linux/amd64`,但同目錄 README 寫 `linux/amd64,linux/arm64`。以實際 k3s 節點架構為準,改成一致
- **base image**:v0.95 的 Dockerfile 已是 `node:26-slim`(本地是 `node:22-alpine`),build 時間與 image 大小會變,cache 策略要重測
- 這項**最先做**,後面每個功能才有得部署驗證

---

## 9. 重做順序

| 階段 | 內容 | 產出 |
|---|---|---|
| 0 | main ff 到 v0.95、基礎設施升級、跑完上游 migration | 乾淨的 v0.95 環境跑得起來 |
| 1 | **F6** CI/CD | 之後每個 PR 都能自動部署驗證 |
| 2 | **F4 + F5** | 小而獨立,先拿兩個 PR 熱身、確認新 base 的編輯器改動幅度 |
| 3 | **F3** 先量測再修 | 決定 F1 要處理多少協作端的坑 |
| 4 | **F2** 決策 + 實作 | 需要你先拍板 A/B/C |
| 5 | **F1** GitHub 同步 | 拆 4 個 PR:① migration + GitHub API client ② 全量同步 + link rewrite ③ webhook 增量 ④ 前端 + SSE |

F1 的四個 PR 之間有依賴,但每個都可獨立測試與 review。

---

## 10. 不要帶回去的清單

- `r2-token.controller.ts` — 路徑 bug、無授權的測試端點
- `github_plan.md`、`github_pr.md` — 未實作的設計稿,要留就進 `doc/` 並標註「未實作」
- root 的兩份 `*_SETUP.md` — 移進 `doc/`,且 R2 那份的內容與實作不符,要重寫
- 舊的 `AGENTS.md`(43 行 `/init` 產物) — 用 main 上新的那份取代
- 所有 emoji log 與 `console.log`
- `setImmediate()` 跑背景同步 — 改 BullMQ
- 行程內記憶體快取(R2 token、SSE Subject) — 改 Redis

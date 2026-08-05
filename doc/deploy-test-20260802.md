# 部署後端到端測試報告 — 2026-08-02

對 `feat/rebuild-on-v095` 建出的 image 做的第一次真實環境測試。在此之前這個 fork **從未實際跑起來過**(見 `fork-redo-spec.md` §實作狀態的「尚未做的」),所有結論都只來自 build 與 typecheck。

這份文件記錄實際跑起來之後發現的東西。規格與設計意圖看 `fork-redo-spec.md`,這裡只記**實測結果與證據**。

---

## 環境

| | |
|---|---|
| Image | `ghcr.io/audichuang/docmost:feat-rebuild-on-v095` |
| 主機 | Synology DSM 7.4.1,`/volume5/docker/docmost/` |
| 容器 | `docmost` / `docmost-db`(postgres:18)/ `docmost-redis`(redis:8) |
| 對內 | `http://<NAS 內網 IP>:13000` |
| 對外 | `https://<部署網域>`(既有的 dashboard 管理型 cloudflared tunnel) |
| 測試 repo | `audichuang/AWS-SAA-Note` @ `main`,子目錄 `note`(135 md / 62 圖) |
| GitHub App | `docmost-nas`,App ID 4461720,Contents+Metadata read-only,只訂閱 `push` |
| R2 Worker | 既有的 `<R2 圖片網域>` |

測試手段:專用 headless Chrome 走 CDP 操作 UI(不動使用者自己的瀏覽器)、`psql` 直接查 DB 驗證落庫、SSH + docker 檢查 storage 與 log、curl 打端點。

### 起點狀態

全新未初始化:`users=0 workspaces=0 pages=0`。所有測試資料都是這次產生的。

---

## 部署設定上踩到的坑

### compose 的 `environment:` 是逐個列舉的

原本的 `docker-compose.yml` 只列了 `APP_URL` / `APP_SECRET` / `DATABASE_URL` / `REDIS_URL` 四個。**把 GitHub / R2 的變數加進 `.env` 完全不會進到容器裡**,而且沒有任何錯誤 —— `EnvironmentService` 讀不到就當作「功能未設定」,靜默停用。

這正是那種會讓人查半天的失敗模式:`.env` 看起來對、容器也起來了、功能就是不動。

處理:給 `docmost` service 加 `env_file: .env`,取代逐個對應 11 個新變數。**只加在 `docmost`**,不要加在 `db` —— 用 sed 批次替換會連 postgres 一起加上去,等於把 GitHub 私鑰跟 R2 secret 灌進資料庫容器的環境。

### GitHub App 的 Callback URL 不能用 IP

GitHub 現在只接受 HTTPS(`localhost` 除外),填 `http://<NAS 內網 IP>:13000/...` 會被擋在「Callback URL must be a valid URL」。必須走網域。

連帶 `APP_URL` 也要改成同一個網域,否則 callback 完成後的 redirect、邀請信與分享連結都會指回 LAN IP。**客戶端不受影響** —— `getBackendUrl()` 用的是 `window.location`,不是 `APP_URL`(`apps/client/src/lib/config.ts:25`)。

### Webhook 打得到 LAN 嗎:可以,因為自架模式不看 hostname

`/api/integrations/github/webhook` 不在 `main.ts` 的 `excludedPaths` 裡,所以需要解析出 workspace。但 `domain.middleware.ts` 在 `isSelfHosted()` 時是 `workspaceRepo.findFirst()`,**完全不看 hostname**,所以任何網域進來都解析得到。tunnel 轉進來沒問題,實測從公網打回 `401 webhook_not_configured` 而非 404。

---

## 測試結果

### 第 0 層 — 基礎可用性:全通過

| 項目 | 證據 |
|---|---|
| setup 建 workspace + 管理員 | 導向 `/home`、自動登入、預設 space `General` |
| 建頁 / 編輯 / 重整 | hard reload 後標題與內文完整 |
| **三份表示同時寫入** | `content` 非空、`text_content` 58 字元、`ydoc` 302 bytes |

AGENTS.md 的頭號硬約束(`content` / `textContent` / `ydoc` 不可只寫其一)在正常編輯路徑上成立。

### 第 1 層 — 上游 v0.95 沒被我們的 build 弄壞:全通過

| 項目 | 證據 |
|---|---|
| 即時協作 | 兩個分頁,A 打的字即時出現在 B,含遠端游標標籤 |
| 附件上傳 | 檔案落在 `/volume5/docker/docmost/storage/…`,owner `1000:1000`,size 一致 —— **bind mount 的 uid 對齊真的有效** |
| 搜尋 | 剛打的字立刻搜得到並高亮,`text_content` 索引跟得上編輯 |
| 匯出 | zip = `.md` + `files/<id>/x.png` + `docmost-metadata.json`,圖片路徑改寫成相對 |
| 匯入 | 同一個 zip 匯回,新 page id + 新 attachment id,圖片 `naturalWidth` 64×64 真的載入 |
| 頁面搬移 | `POST /api/pages/move` → 200,`parent_page_id` 正確,`position` 是 fractional index **字串**(`a04Ir` / `a0Vaa`) |

EE 功能(匯入的 Word/PDF/Confluence、頁面選單的 Add verification)呈灰 —— `apps/server/src/ee` 是空的,預期行為。

### 第 2 層 — 免外部設定的自製功能

| 項目 | 結果 |
|---|---|
| Mermaid 插入與 render | PASS |
| Mermaid 全螢幕:滾輪縮放 | PASS,`scale(6.82)` → `7.64` → `6.82`(6.82 是 auto-fit) |
| Mermaid 全螢幕:拖曳平移 | PASS,`translate(0,0)` → `translate(160px,100px)`,scale 不變 |
| Mermaid 全螢幕:Esc 關閉 | PASS |
| URL 插圖:有效 URL | PASS,`naturalWidth=64` |
| URL 插圖:`javascript:alert(1)` | PASS,`sanitizeUrl` 擋下並顯示錯誤,未插入 |
| URL 插圖:非圖片 http URL | **與 handoff 預期不符**,見下 |
| 鎖定頁 REST `update`/`move`/`move-to-space`/`delete` | 四條全 **403** |
| 鎖定頁 協作 socket | 伺服器端有效,DB 沒有寫入的字 |
| 鎖定頁 前端 | **有問題**,見下 |

### 第 3 層 — GitHub 同步 / R2

| 項目 | 結果 |
|---|---|
| App JWT 認證 | PASS,`.pem` 簽 RS256 打 `GET /app` → id / slug / client_id 全相符 |
| installation 綁定(含 B1 擁有權檢查) | PASS |
| 全量同步 | PASS,約 2.5 分鐘,**135/135 markdown、11 folder、37 asset,status 全 `synced`,零錯誤** |
| 子目錄過濾 | PASS,只同步 `note/`,其餘 6 個頂層目錄沒進來 |
| 目錄 → 頁面樹 | PASS,層級正確,標題取自 markdown H1(emoji 保留) |
| 有 README 的資料夾 | PASS,README 內容就是資料夾頁本身,沒有多一頁 |
| 手動 rescan | PASS,counts 不變、零錯誤,只 touch 11 個 folder row(資料夾無 SHA) |
| push webhook | PASS,**1 秒收到事件、4 秒完成落庫** |
| webhook:修改既有檔 | PASS,`text_content` 55137→55226,marker 同時進 `text_content`、`content`、**ydoc** |
| webhook:新增檔案 | PASS,新頁面、標題取自 H1、`is_locked=true`、`ydoc` 非空 |
| webhook:刪除檔案 | PASS,mapping 轉 `deleted`,頁面進垃圾桶(可還原)、仍鎖定 |
| webhook:增量精準度 | PASS,第一次只 touch 2 個變動檔(182 個沒動),第二次只 touch 1 個 |
| 同步頁鎖定(markdown) | PASS,135 個全 `is_locked=true` |
| 相對路徑圖片 → attachment | **改寫正確、檔案落地,但一張都顯示不出來**,見下 |
| R2 token 鑄造 | PASS,前端 424ms 取得並排程 270 秒續約 |
| R2 token 接到圖片上 | **從未發生**,見下 |

---

## 發現的問題

### 🔴 P1 — GitHub 同步進來的圖片 100% 顯示不出來(404)

**症狀**:同步頁面上的圖片,`naturalWidth` 全部是 0。

> 數字更正:初版寫「49 個 image 節點」。實際是 **21 個** —— DOM 裡另外 28 個 `<img>` 是 ProseMirror 自己的 `ProseMirror-separator`(零尺寸、用來放游標,`naturalWidth` 本來就永遠是 0)。用 `.ProseMirror img` 計數把它們算進來了。結論不變(真實圖片當時 21 張全 404),數字虛報。

**證據**:

- 檔案本身沒問題:`blueprint15_p01.png` 在容器內 `/app/data/storage/…` 是 3292685 bytes,owner `1000:1000`
- URL 改寫正確:`![](images/blueprint15_p01.png)` → `"src": "/api/files/faba7298-265b-5605-896d-baf97be45c53/blueprint15_p01.png"`
- 但 `GET /api/files/faba7298-…/blueprint15_p01.png` 回 **404**
- 手動上傳的圖片用同樣的 URL 格式,一切正常

**根因**,`apps/server/src/core/attachment/attachment.controller.ts:192`:

```ts
if (!attachment.pageId || !attachment.spaceId) {
  throw new NotFoundException();
}
```

`apps/server/src/integrations/github/github-asset.service.ts:161-173` 建立 attachment 時只填 `spaceId`,**沒有 `pageId`** —— 這是刻意的,同一張圖可能被多頁引用。DB 實測:37 個同步 attachment 全部 `page_id IS NULL` / `space_id` 有值。兩邊對不上。

**這不是未知的設計取捨,是漏做的一步。** `fork-redo-spec.md` §F1.5 第 9 點寫得很清楚:

> 9. 附件:rewrite 階段先建立無 pageId 的 attachment,**頁面建好後回填 `page_id`**

那個回填不存在。整個 `apps/server/src/integrations/github/` 沒有任何一處 `updateTable('attachments')`,`github-asset.service.ts` 裡連 `pageId` 這個字串都沒出現。

**影響**:F1(GitHub 內容同步)是這個 fork 的旗艦功能,而同步進來的筆記只要有圖就是一片破圖。以測試 repo 為例,`note/` 底下引用了 36 張圖的 3 篇筆記全毀。

**修法二選一**:

1. 同步完成後回填 `page_id` —— spec 原本的設計。一張圖被多頁引用時只能挑一頁,權限判定會跟著那頁走,語意上有點勉強。
2. 放寬 `getFile`:`pageId` 為 null 但 `spaceId` 有值時,改用 space 層權限判定。更貼近「跨頁共用資產」的語意,但會動到 core 的授權路徑,要確認不會放寬到不該放寬的地方。

### 🔴 P2 — R2 圖片 token 掛在 v0.95 已經不用的渲染路徑上

**症狀**:插一張 `https://<R2 圖片網域>/sample/test.png`,render 出來的 `<img src>` 沒有 `?token=`。

**先排除的**:後端全對。`/api/r2/token` 回 200 帶真 token(`<timestamp>.<hmac>`,含 `.`、有 `expiresAt`),`window.CONFIG.R2_IMAGE_DOMAIN` 有注入,前端在 424ms 就拿到 token 並排程 270 秒後續約(不是走 `catch { scheduleNext(30_000) }` 的失敗路徑),圖片請求發生在 1128ms —— **token 早就在手上了**。

**根因**:v0.95 換了 image node view。`packages/editor-ext/src/lib/image/image.ts:256`

```ts
el.src = normalizeFileUrl(HTMLAttributes.src);
```

`normalizeFileUrl()`(`packages/editor-ext/src/lib/media-utils.ts:3`)只做一件事:把 `/files/` 前綴補成 `/api/files/`。對絕對網址原封不動,完全不知道 R2 的存在。

而這次的實作是把 `appendR2Token` 掛在 `apps/client/src/lib/config.ts:64` 的 `getFileUrl()` 上。`getFileUrl` 現在只剩 `image-view.tsx:45` 這個 React view 在用,而它**只在 `!HTMLAttributes.src`(上傳中的 placeholder)那條分支才會被建立**(`image.ts:219-225`)。圖片一旦有 src —— 也就是所有真實圖片 —— 就走純 DOM 的 `<img>`。

**DOM 實證**:圖片的 class 是 `media-pulse`、外層 `_container_1ymd3_1 node-image`,不是 Mantine `<Image>` 的 `.mantine-Image-root`。

這是典型的「移植到新 base 時 hook 點搬家了」:功能原本寫在 v0.23(`origin/dev`),那時 `image-view.tsx` 就是渲染器;v0.95 把 node view 改成 editor-ext 裡的純 DOM 版本,移植時沒跟上。build 與 typecheck 抓不到這種問題 —— 兩邊都是合法的程式碼,只是其中一邊沒人呼叫。

**同樣受影響**:`drawio.ts`、`audio.ts`、`excalidraw.ts`、`video.ts` 都用 `normalizeFileUrl`。

**修法**:token 要接在 editor-ext 的 node view 裡。但 editor-ext 是前後端共用套件(AGENTS.md),token 邏輯不能塞進去 —— 乾淨做法是從 client 端經 extension options 注入一個 URL resolver,讓 node view 呼叫它而不是直接呼叫 `normalizeFileUrl`。

### 🟡 P3 — 沒有 README 的資料夾頁沒有被鎖(§0.35 B2 第三項,現有實例)

11 個 folder 頁裡 **9 個鎖了、2 個沒鎖**:`note/Disaster-Recovery-and-Migrations/`、`note/other_service/`。

有 `README.md` 的資料夾,folder page 直接用 README 那一頁,所以繼承了 markdown 的鎖(這也是為什麼「README 內容出現在資料夾頁本身」這條驗收會過)。沒有 README 的純結構資料夾自己生一個頁面,**從頭到尾沒被鎖過** —— UI 上打開就是一頁空白、可編輯的頁面。

這兩頁的子樹共 4 頁,其中 **2 頁是鎖定的**。搭配 §0.35 第 2 項(trash 與 move-to-space 檢查根節點後就遞迴處理子孫),使用者可以把這個未鎖的資料夾頁丟進垃圾桶,**連帶把底下鎖定的同步頁一起帶走**。

從「理論上會」升級成「有具體實例」。

### 🟡 P4 — 鎖定頁的 IndexedDB 幻影編輯(spec 第 453 行點名要做、沒做)

在鎖定頁打字:編輯器**照常接受輸入**(`contenteditable` 仍是 `true`),重新整理後**字還在**。但 DB 的 `text_content` 從頭到尾沒有那段字。清掉瀏覽器的 IndexedDB 之後幻影消失。

使用者視角:以為改好了、重整也還在,實際上伺服器沒收、其他人看不到、換台機器就沒了。**靜默資料遺失。**

伺服器端的鎖是有效的(REST 四條 403、socket `readOnly`),壞的是前端沒有反映鎖定狀態,加上 `apps/client/src/features/editor/page-editor.tsx:206` 無條件建立 `IndexeddbPersistence`。fork 對這支檔案的 diff 是空的。

spec 第 453 行已經點名「locked 頁面跳過 IndexedDB」是必須自己加的(因為唯讀頁的概念是自製的,上游不會有),第 460 行的驗收 checkbox 也還沒打勾。

現在 135 個同步頁全部中招。

### ⚪ P5 — 「非圖片 URL 應有錯誤提示」在程式碼裡不存在

`https://example.com/not-an-image.html` 會直接插入、無錯誤提示、render 成 `naturalWidth=0` 的破圖。

`apps/client/src/features/editor/components/image/image-url-modal.tsx` 只有 `sanitizeUrl` 的 protocol 檢查(擋 `javascript:` 等),沒有任何圖片型別檢查。這是交接文件的預期與實作不符,不是 bug —— 但要決定是補檢查還是改預期。

---

## 順帶驗證:已經修好的

### §0.35 B2 的 REST 部分已修

B2 原文:「`isLocked` 只在 WebSocket authenticate 時生效。REST 仍可改標題/內容、搬移、丟垃圾桶」。

實測四條 REST 路徑對鎖定頁**全部回 403** `This page is locked and cannot be modified`:

| 路徑 | 守衛位置 |
|---|---|
| `POST /api/pages/update` | `page.controller.ts:279` |
| `POST /api/pages/delete` | `page.controller.ts:349` |
| `POST /api/pages/move-to-space` | `page.controller.ts:587` |
| `POST /api/pages/move` | `page.controller.ts:720` |

已被 `b2ee9d46` 修掉。B2 剩下的兩點(鎖定前已建立的連線、沒有 README 的資料夾頁)**仍開著**,後者見 P3。

### B1 擁有權檢查實證有效

第一次安裝 App 時 callback 失敗、`github_installations` 是空的 —— 因為 GitHub 沒送 `code`,`evaluateInstallationOwnership` 回 `missing_oauth_code` 直接拒絕。這是刻意的 fail-closed。

確認 App 的「Request user authorization (OAuth) during installation」勾好、移除安裝重來之後綁定成功。**綁定成功本身就證明了整條 B1 路徑跑通**:GitHub 送了 `code`、`exchangeUserCode` 換到 user token、`GET /user/installations` 回的清單包含這個 installation_id。

診斷過程順帶確認 client secret 有效 —— 用假 code 打 GitHub 的 OAuth 端點,回 `bad_verification_code` 而不是 `incorrect_client_credentials`。

---

## 未測 / 測不到

| 項目 | 原因 |
|---|---|
| 頁面樹**拖拉**的輸入機制 | CDP `Input.dispatchDragEvent` 第一次攔到 drag,完成 drop 後 session 卡住無法重入。樹是**未修改的上游程式碼**(fork diff 完全沒碰 `features/page/tree/`),且打的是已驗過的同一支 move API |
| 改名檔案的 webhook 行為(§0.35 B4) | 沒測 |
| 同一 webhook 重送兩次的冪等 | 沒測(程式碼有 `delivery_id` unique + `shouldReplayDelivery`) |
| 開著頁面時 push 是否即時更新且不斷線 | 沒測 |
| B2 剩下的「鎖定前已建立的連線還能寫」 | 沒測 |
| §0.35 的其餘 7 項 | 多數需要並發或大 repo 才觸發 |
| tree truncated 的行為(§0.35 第 8 項) | 測試 repo 的 tree 沒有 truncated |
| 圖片 token 的完整鏈路(過期換發、直連 401) | 卡在 P2,token 根本沒接上 |

---

## 這次改動了什麼

### NAS

- `.env`:`APP_URL` 改成 `https://<部署網域>`,新增 11 個變數(GitHub 8 + R2 3)
- `docker-compose.yml`:`docmost` service 加 `env_file: .env`
- 備份:`.env.bak-20260802`、`docker-compose.yml.bak-20260802`
- 容器重建一次(`docker compose up -d docmost`),停機約 15 秒

回滾:還原兩個備份檔再 `docker compose up -d docmost`,image 不變。

### 測試資料

Docmost 的 `Audi Workspace` / `General` space 裡有:2 頁手動測試頁(含 mermaid、破圖的 example.com 圖片、R2 測試圖)、135 頁 GitHub 同步內容、垃圾桶 1 頁。GitHub sync source 一個(`AWS-SAA-Note` @ `main` / `note`)。

### `audichuang/AWS-SAA-Note`

3 個 commit(`1e7f33a` 加內容 → `56c8200` 再加 → `54b130c` 還原)。**檔案內容已完全還原**,`git diff ac8b629 HEAD -- note/` 為空,只是 history 多了 3 筆。

### 本機

GitHub App 私鑰從 `research/docmost/.orca/drops/`(**沒有被 gitignore,`git add .` 就會被 commit**)移到 `~/.secrets/`,權限 600。

---

## 修復與複驗(同日,commit `3afb3852`)

P1–P4 全部修掉並重新部署(image digest `fac6141b` → `c0811a12`),在同一台機器上複驗。

| # | 修法 | 複驗證據 |
|---|---|---|
| P1 | `attachment.controller.ts`:`pageId` 為 null 但 `spaceId` 有值時,改用 space 層 `Read Page` 判定;`getPublicFile` 的 pageId 相等檢查只在有 owning page 時才套用 | 先前全破的那頁,**21/21 圖片載入**(2752×1536 實際尺寸),DB ground truth 同樣是 21 個 image 節點 |
| P2 | `media-utils.ts` 加一個 module-level transformer,`main.tsx` 在第一次 render 前裝上 `appendR2Token` | `<R2 圖片網域>/...` 的圖 render 出 `?token=<timestamp>.<hmac>`,另外 3 個非 R2 網域的 URL 原封不動 |
| P3 | `ensureFolderChain` 建立時鎖定,並在每次同步 reconcile 既有的資料夾頁 | rescan 後 **11/11** 資料夾頁 `is_locked=true`(先前 9/11) |
| P4 | `page.tsx` 的 `canEdit` 納入 `!isLocked`;鎖定頁跳過 `IndexeddbPersistence` | 鎖定頁 `contenteditable=false`、打字沒進去、`indexedDB.databases()` 裡**沒有這一頁**的 store |

沒有動的:**P5**(非圖片 URL 無提示)。圖床 URL 常常沒有副檔名 —— 這個實例自己的 `<R2 圖片網域>/sample/test.png` 有,但多數圖床沒有 —— 加副檔名檢查會誤殺真圖片。改預期而非改程式。

修法上的取捨,兩個值得記住:

- **P1 沒有照 spec 第 293 行的「回填 `page_id`」做。** 回填會讓一張被多頁引用的圖只能綁一頁,其他頁上的同一張圖就壞了。改成 space 層判定的代價是少了 `pagePermissionRepo` 的 per-page 限制層:某張同步頁若被設成限定成員,圖仍然全 space 可讀。同步內容目前都來自同一個 source、進同一個 space,這個模型是自洽的。
- **P2 沒有逐個改 5 種節點的 extension option。** `normalizeFileUrl` 有 9 個呼叫點,一個 module-level hook 全部涵蓋,而且 server 端不裝 transformer,`tiptapExtensions` 行為完全不變。

## 給下一輪的建議

先修 P1 —— 它讓旗艦功能的產出在有圖的頁面上直接不能看,而且修法很小(一次回填,或一個授權分支)。P2 次之,修法要動到 editor-ext 的介面設計,值得先想清楚 resolver 要怎麼注入。P3 / P4 是同一類問題的兩面:**鎖定狀態沒有一路傳到前端**,可以一起處理 —— 前端拿到 `isLocked` 之後同時做三件事:編輯器設唯讀、跳過 IndexedDB、資料夾頁也套用。

---

## 關於這份文件的脫敏

部署網域、R2 圖片網域、NAS 內網 IP 都寫成佔位符(`<部署網域>` 等)—— 這個 repo 是 public,而同一份文件同時列出那個實例仍開著的授權問題。實際值在本機:部署座標見 `~/.config/docmost-test.env`,NAS 連線見 `~/.config/synology-container.env`(兩個都 600、都不進版控)。

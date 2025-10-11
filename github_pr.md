# GitHub PR 工作流 - 完整設計規劃

## ✏️ 修訂說明（基於 CR 反饋）

本文檔已根據 Code Review 反饋進行關鍵修正，確保功能正確性和與現有代碼庫對齊。

### 已修正的問題

#### 🔴 關鍵 Bug 修復
1. **Race Condition Bug** - `onPageEditEnd` 邏輯順序修正
   - 問題：先設置 `isActive=false`，然後查詢 `isActive=true` 的 session（查不到）
   - 修正：先獲取 session 和檢查變更，最後才設置為結束
   - 位置：`流程 1.3`

2. **多用戶編輯約束** - 移除 UNIQUE 約束
   - 問題：`UNIQUE(page_id, is_active)` 阻止多人協作編輯
   - 修正：改為 INDEX，支援 Y.js 多人即時協作
   - 位置：`數據模型 - github_edit_sessions`

3. **isLocked 條件化** - 根據 mode 決定是否鎖定
   - 問題：所有 GitHub 頁面都被鎖定，PR mode 也無法編輯
   - 修正：只有 `mode='readonly'` 才鎖定，`pr_workflow` 可編輯
   - 位置：`流程 10`

#### 🟡 重要改進
4. **延遲 Webhook 重新處理** - 防止同步遺失
   - 新增：`reprocessDeferredWebhooks()` 函數
   - 位置：`流程 1.3` 結尾

5. **文件級別衝突檢測** - 減少誤報
   - 問題：只比對分支 HEAD，導致其他文件變更也報衝突
   - 修正：比對文件 SHA，只有該文件真正變更才報衝突
   - 位置：`流程 5`

6. **Schema 對齊** - 使用現有欄位
   - 問題：新增 `sync_mode` 欄位重複
   - 修正：使用現有 `mode` 欄位，新增 CHECK 約束
   - 位置：`數據模型 - github_sources`

### 延後至 Phase 2 的優化
- 附件 SHA 追蹤（避免重複上傳）
- Queue 系統（BullMQ 整合）
- Markdown serializer 增強（任務列表、複雜表格）
- 分支自動清理

---

## 📋 目錄
1. [核心問題分析](#核心問題分析)
2. [設計原則](#設計原則)
3. [架構設計](#架構設計)
4. [數據模型](#數據模型)
5. [核心流程](#核心流程)
6. [API 設計](#api-設計)
7. [前端實現](#前端實現)
8. [錯誤處理](#錯誤處理)
9. [實現階段](#實現階段)

---

## 核心問題分析

### 🔥 問題：即時儲存 vs 遠端推送的競態條件

#### 場景描述
```
T0 (00:00): 用戶 A 開啟頁面編輯（base_sha = abc123）
T1 (00:01): 用戶 A 輸入文字，Y.js 自動同步到 server，DB 已更新
T2 (00:02): 用戶 B 在 GitHub 推送新 commit（sha = def456）
T3 (00:03): GitHub webhook 觸發，Docmost 自動同步
          ❌ 問題：會直接覆蓋用戶 A 的修改！
T4 (00:04): 用戶 A 繼續編輯，但基礎版本已經錯亂
```

#### 資料流分析

**Docmost 編輯器機制（現有）：**
```
User Input → TipTap Editor → Y.js CRDT → WebSocket
  → Server (Hocuspocus) → DB (pages.ydoc + pages.content)
```

**特性：**
- ✅ 即時自動儲存（無需手動 Save）
- ✅ 支援多人協作編輯（CRDT）
- ❌ 沒有 "草稿" 概念，都是直接更新 DB

**GitHub Webhook 同步機制（現有）：**
```
GitHub Push → Webhook → handlePush()
  → 獲取新內容 → 轉換格式 → 直接更新 DB
  → pageRepo.updatePage() → 覆蓋 pages.content + pages.ydoc
  → collab.closeDocumentConnections() → 強制斷開所有編輯連線
```

#### 💥 衝突場景分類

| 場景 | 用戶狀態 | GitHub 狀態 | 結果 |
|------|---------|------------|------|
| **場景 1** | 正在編輯中 | Push 新內容 | ❌ **資料丟失** - Webhook 覆蓋編輯內容 |
| **場景 2** | 編輯完成，未推送 PR | Push 新內容 | ❌ **版本衝突** - 本地基於舊版本 |
| **場景 3** | 正在創建 PR | 同時有人 Push | ❌ **PR 過時** - PR 基於舊版本 |
| **場景 4** | PR 正在 GitHub Review | 原始分支又 Push | ❌ **PR 需要 rebase** |

---

## 設計原則

### 🎯 核心目標
1. **資料安全第一**：絕不能因為自動同步而丟失用戶編輯內容
2. **衝突可見化**：讓用戶清楚知道發生衝突，而非靜默覆蓋
3. **明確的操作流程**：用戶需要主動 "推送"，而非自動
4. **利用 GitHub PR 機制**：避免重複造輪子

### 🛡️ 解決策略

#### 策略 A：編輯鎖定 + 延遲同步（推薦）
```
1. 頁面進入編輯模式時，標記為 "editing"
2. Webhook 檢測到該頁面在編輯中，跳過同步
3. 編輯結束時（關閉頁面/一段時間無操作），解除鎖定
4. 延遲同步：定期檢查是否有未同步的遠端變更，提示用戶
```

**優點：** 保護正在編輯的內容，不會被覆蓋
**缺點：** 同步會延遲，需要手動處理衝突

#### 策略 B：分支隔離（備選）
```
1. 啟用 "可編輯" 的 Source 時，自動在 GitHub 創建專屬分支
2. Docmost 只監聽主分支（main）的 webhook
3. 編輯的內容推送到專屬分支
4. 創建 PR 時從專屬分支 → main
```

**優點：** 完全避免衝突
**缺點：** 需要管理分支生命週期，複雜度較高

#### 策略 C：快照比對（最保守）
```
1. Webhook 觸發時，先比對 DB 內容與最後同步的快照
2. 如果 DB 內容已被修改（sha 不同），標記為衝突
3. 不自動覆蓋，通知管理員處理
```

**優點：** 最安全
**缺點：** 需要額外儲存快照，增加複雜度

### ✅ 本方案選擇：**策略 A（編輯鎖定 + 延遲同步）**

理由：
- 實現相對簡單
- 充分利用 Docmost 現有的協作編輯機制
- 用戶體驗較好（不需要等分支創建）

---

## 架構設計

### 整體架構圖

```
┌─────────────────────────────────────────────────────────────────┐
│                         GitHub Repository                        │
│  ┌──────────┐    ┌──────────┐    ┌──────────────────────────┐  │
│  │  main    │◄───│  PR #123 │◄───│ docmost-page-abc (branch)│  │
│  │ branch   │    │          │    │                          │  │
│  └────┬─────┘    └──────────┘    └────────▲─────────────────┘  │
│       │                                     │                    │
│       │ Push                                │ Push (PR create)   │
└───────┼─────────────────────────────────────┼────────────────────┘
        │                                     │
        │ Webhook                             │
        ▼                                     │
┌─────────────────────────────────────────────┼────────────────────┐
│                    Docmost Backend          │                    │
│  ┌──────────────────────────┐              │                    │
│  │  GithubWebhookController │              │                    │
│  │  ┌─────────────────────┐ │              │                    │
│  │  │ Check Edit Lock     │ │              │                    │
│  │  │ If locked → Skip    │ │              │                    │
│  │  │ If not → Sync       │ │              │                    │
│  │  └─────────────────────┘ │              │                    │
│  └────────────┬─────────────┘              │                    │
│               │                             │                    │
│               ▼                             │                    │
│  ┌──────────────────────────┐   ┌──────────┴────────────────┐  │
│  │  GithubSyncService       │   │  GithubPRService          │  │
│  │  - fullSync()            │   │  - createBranch()         │  │
│  │  - handlePush()          │   │  - convertToMarkdown()    │  │
│  │  - checkEditLock() ◄─────┼───┤  - uploadFiles()          │  │
│  └──────────┬───────────────┘   │  - createPR()             │  │
│             │                   └───────────────────────────┘  │
│             ▼                                                   │
│  ┌────────────────────────────────────────────────────────┐   │
│  │              Database (PostgreSQL)                      │   │
│  │  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐ │   │
│  │  │ github_files │  │ pages        │  │ github_edits │ │   │
│  │  │ - base_sha   │  │ - content    │  │ - page_id    │ │   │
│  │  │ - local_sha  │  │ - ydoc       │  │ - is_editing │ │   │
│  │  └──────────────┘  └──────────────┘  └──────────────┘ │   │
│  └────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
        ▲                                     │
        │                                     │
        │ WebSocket (Y.js)                    │ HTTP API
        │                                     ▼
┌─────────────────────────────────────────────────────────────────┐
│                      Docmost Frontend                            │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │  Page Editor                                              │  │
│  │  ┌─────────────────┐  ┌──────────────────────────────┐   │  │
│  │  │ Edit Status Bar │  │  PR Creation Modal           │   │  │
│  │  │ ● Synced        │  │  - Select changes            │   │  │
│  │  │ ● Modified      │  │  - Preview diff              │   │  │
│  │  │ ● Conflict      │  │  - Enter commit message      │   │  │
│  │  └─────────────────┘  │  - Create PR button          │   │  │
│  │                       └──────────────────────────────┘   │  │
│  └───────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

### 同步模式設計

#### Source 的三種模式

```typescript
enum SyncMode {
  READONLY = 'readonly',      // GitHub → Docmost (現有實現)
  WRITEONLY = 'writeonly',    // Docmost → GitHub (禁用 webhook)
  PR_WORKFLOW = 'pr_workflow' // 雙向，但透過 PR (本次實現)
}
```

**PR_WORKFLOW 模式特性：**
- ✅ 接收 GitHub main branch 的 webhook
- ✅ 允許在 Docmost 編輯
- ✅ 編輯時暫停 webhook 更新（編輯鎖）
- ✅ 推送時創建新分支 + PR
- ❌ 不直接推送到 main branch

---

## 數據模型

### 1. 修改現有表

#### `github_sources` 修改欄位
```sql
-- ✅ 使用現有的 mode 欄位，不新增 sync_mode
ALTER TABLE github_sources
ALTER COLUMN mode TYPE varchar;

-- 更新 CHECK 約束以支援新模式
ALTER TABLE github_sources
DROP CONSTRAINT IF EXISTS github_sources_mode_check;

ALTER TABLE github_sources
ADD CONSTRAINT github_sources_mode_check
CHECK (mode IN ('readonly', 'writeonly', 'pr_workflow'));

-- 新增 PR 相關欄位
ALTER TABLE github_sources
ADD COLUMN pr_branch_prefix varchar DEFAULT 'docmost-sync',
ADD COLUMN last_pr_number int,
ADD COLUMN last_pr_url varchar;
```

#### `github_files` 新增欄位
```sql
-- ⚠️ 注意：不在此表新增 base_sha（會在 github_pending_changes 追蹤）
ALTER TABLE github_files
ADD COLUMN has_local_changes boolean DEFAULT false,
ADD COLUMN last_synced_at timestamptz,
ADD COLUMN github_pr_url varchar;         -- 關聯的 PR URL
```

#### `github_webhook_events` 新增欄位
```sql
-- 用於追蹤延遲處理的 webhook
ALTER TABLE github_webhook_events
ADD COLUMN deferred boolean DEFAULT false,
ADD COLUMN defer_reason text;
```

### 2. 新增表：`github_edit_sessions`

**用途：** 追蹤哪些頁面正在被編輯，保護編輯中的內容

```sql
CREATE TABLE github_edit_sessions (
  id uuid PRIMARY KEY DEFAULT gen_uuid_v7(),
  page_id uuid NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  github_file_id uuid REFERENCES github_files(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id),

  -- 編輯狀態
  is_active boolean NOT NULL DEFAULT true,
  started_at timestamptz NOT NULL DEFAULT now(),
  last_activity_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz,

  -- 版本追蹤
  base_sha varchar NOT NULL,              -- 開始編輯時的 GitHub SHA
  snapshot_content jsonb                  -- 開始編輯時的內容快照
);

-- ✅ 索引：允許多人同時編輯（支援 Y.js 協作）
CREATE INDEX idx_github_edit_sessions_active
ON github_edit_sessions(page_id, is_active)
WHERE is_active = true;

-- 可選：防止同一用戶重複開啟編輯
CREATE UNIQUE INDEX idx_github_edit_sessions_user_active
ON github_edit_sessions(page_id, user_id, is_active)
WHERE is_active = true;

CREATE INDEX idx_github_edit_sessions_last_activity
ON github_edit_sessions(last_activity_at)
WHERE is_active = true;
```

### 3. 新增表：`github_pending_changes`

**用途：** 追蹤哪些頁面有未推送的修改

```sql
CREATE TABLE github_pending_changes (
  id uuid PRIMARY KEY DEFAULT gen_uuid_v7(),
  source_id uuid NOT NULL REFERENCES github_sources(id) ON DELETE CASCADE,
  github_file_id uuid NOT NULL REFERENCES github_files(id) ON DELETE CASCADE,
  page_id uuid NOT NULL REFERENCES pages(id) ON DELETE CASCADE,

  -- 變更內容
  change_type varchar NOT NULL,           -- 'create' | 'update' | 'delete'
  base_sha varchar,                       -- 基於哪個 GitHub 版本做的修改
  current_content jsonb NOT NULL,         -- 當前的 TipTap JSON
  converted_markdown text,                -- 預轉換的 Markdown（可選，用於預覽）

  -- 衝突檢測
  remote_sha varchar,                     -- 遠端最新的 SHA（用於比對）
  has_conflict boolean DEFAULT false,
  conflict_checked_at timestamptz,

  -- 元數據
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  UNIQUE(github_file_id),                 -- 一個文件只有一個 pending change
  CHECK (change_type IN ('create', 'update', 'delete'))
);

CREATE INDEX idx_github_pending_changes_source
ON github_pending_changes(source_id);

CREATE INDEX idx_github_pending_changes_conflict
ON github_pending_changes(has_conflict)
WHERE has_conflict = true;
```

### 4. 新增表：`github_pr_batches`

**用途：** 記錄批次推送的 PR

```sql
CREATE TABLE github_pr_batches (
  id uuid PRIMARY KEY DEFAULT gen_uuid_v7(),
  source_id uuid NOT NULL REFERENCES github_sources(id) ON DELETE CASCADE,

  -- PR 資訊
  branch_name varchar NOT NULL,
  pr_number int,
  pr_url varchar,
  pr_status varchar NOT NULL DEFAULT 'creating',  -- 'creating' | 'open' | 'merged' | 'closed' | 'failed'

  -- 包含的變更
  file_ids uuid[] NOT NULL,               -- 包含哪些 github_files
  file_count int NOT NULL,

  -- 提交資訊
  commit_message text NOT NULL,
  commit_description text,
  created_by uuid NOT NULL REFERENCES users(id),

  -- 時間戳
  created_at timestamptz NOT NULL DEFAULT now(),
  pushed_at timestamptz,
  merged_at timestamptz,

  -- 錯誤追蹤
  error_message text,
  retry_count int DEFAULT 0
);

CREATE INDEX idx_github_pr_batches_source
ON github_pr_batches(source_id, created_at DESC);

CREATE INDEX idx_github_pr_batches_status
ON github_pr_batches(pr_status);
```

---

## 核心流程

### 流程 1：頁面編輯保護機制

#### 1.1 開始編輯
```typescript
// 用戶打開頁面編輯器時觸發
async function onPageEditStart(pageId: string, userId: string) {
  // 1. 檢查該頁面是否來自 GitHub
  const githubFile = await db
    .selectFrom('githubFiles')
    .where('pageId', '=', pageId)
    .innerJoin('githubSources', 'githubSources.id', 'githubFiles.sourceId')
    .where('githubSources.mode', '=', 'pr_workflow')
    .executeTakeFirst();

  if (!githubFile) return; // 不是 GitHub 頁面，無需保護

  // 2. 創建編輯 session
  await db.insertInto('githubEditSessions').values({
    pageId,
    githubFileId: githubFile.id,
    userId,
    isActive: true,
    baseSha: githubFile.sha,
    snapshotContent: await getPageContent(pageId), // 儲存快照
  }).execute();

  // 3. 通知其他協作者（WebSocket）
  await broadcastEditStatus(pageId, {
    type: 'edit_started',
    userId,
    userName: await getUserName(userId)
  });
}
```

#### 1.2 編輯活動追蹤
```typescript
// 用戶每次操作時更新（透過 WebSocket heartbeat）
async function updateEditActivity(pageId: string, userId: string) {
  await db
    .updateTable('githubEditSessions')
    .set({ lastActivityAt: new Date() })
    .where('pageId', '=', pageId)
    .where('userId', '=', userId)
    .where('isActive', '=', true)
    .execute();
}

// 背景任務：定期檢查並清理過期的編輯 session
async function cleanupInactiveSessions() {
  const TIMEOUT = 30 * 60 * 1000; // 30 分鐘無活動視為過期

  const expiredSessions = await db
    .selectFrom('githubEditSessions')
    .selectAll()
    .where('isActive', '=', true)
    .where('lastActivityAt', '<', new Date(Date.now() - TIMEOUT))
    .execute();

  for (const session of expiredSessions) {
    await endEditSession(session.id, 'timeout');
  }
}
```

#### 1.3 結束編輯
```typescript
async function onPageEditEnd(pageId: string, userId: string, reason: 'close' | 'timeout' | 'manual') {
  // 🔥 修正 Race Condition：先獲取 session，再檢查變更，最後才設置為結束

  // 1. 獲取當前活動的 session（還是 active 狀態）
  const session = await db
    .selectFrom('githubEditSessions')
    .selectAll()
    .where('pageId', '=', pageId)
    .where('userId', '=', userId)
    .where('isActive', '=', true)
    .executeTakeFirst();

  if (!session) {
    // 沒有活動 session，可能已經結束過了
    return;
  }

  // 2. 檢查內容是否有變更（使用 session 的快照）
  const currentPage = await db
    .selectFrom('pages')
    .select(['content'])
    .where('id', '=', pageId)
    .executeTakeFirst();

  if (!currentPage) return;

  const snapshotHash = hashContent(session.snapshotContent);
  const currentHash = hashContent(currentPage.content);
  const hasChanges = snapshotHash !== currentHash;

  // 3. 標記 session 為結束
  await db
    .updateTable('githubEditSessions')
    .set({
      isActive: false,
      endedAt: new Date()
    })
    .where('id', '=', session.id)
    .execute();

  // 4. 如果有變更，創建 pending change
  if (hasChanges) {
    await createPendingChange(pageId, userId, session.baseSha);
    await checkRemoteChanges(pageId);
  }

  // 5. 檢查是否還有其他活動的編輯 session
  const otherActiveSessions = await db
    .selectFrom('githubEditSessions')
    .select(['id'])
    .where('pageId', '=', pageId)
    .where('isActive', '=', true)
    .execute();

  // 6. 如果沒有其他人在編輯，重新處理延遲的 webhook
  if (otherActiveSessions.length === 0) {
    await reprocessDeferredWebhooks(pageId);
  }

  // 7. 通知前端更新狀態
  await broadcastEditStatus(pageId, {
    type: 'edit_ended',
    hasChanges,
    userId
  });
}

function hashContent(content: any): string {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(content))
    .digest('hex');
}

// 重新處理延遲的 webhook 事件
async function reprocessDeferredWebhooks(pageId: string) {
  const githubFile = await db
    .selectFrom('githubFiles')
    .innerJoin('githubSources', 'githubSources.id', 'githubFiles.sourceId')
    .selectAll('githubFiles')
    .select(['githubSources.owner', 'githubSources.repo', 'githubSources.ref'])
    .where('githubFiles.pageId', '=', pageId)
    .executeTakeFirst();

  if (!githubFile) return;

  const repoFullName = `${githubFile.owner}/${githubFile.repo}`;

  // 查找被延遲的 webhook 事件
  const deferredEvents = await db
    .selectFrom('githubWebhookEvents')
    .selectAll()
    .where('deferred', '=', true)
    .where('processed', '=', false)
    .where('repoFullName', '=', repoFullName)
    .orderBy('createdAt', 'asc')
    .execute();

  for (const event of deferredEvents) {
    try {
      // 獲取該事件影響的文件
      const filesJson = event.filesJson as any;
      if (!filesJson) continue;

      const allFiles = [
        ...(filesJson.added || []),
        ...(filesJson.modified || []),
        ...(filesJson.removed || [])
      ];

      // 檢查是否包含當前文件
      if (!allFiles.includes(githubFile.path)) continue;

      // 🔥 修正：調用現有的同步邏輯
      // 獲取 source 資訊以進行完整同步
      const source = await db
        .selectFrom('githubSources')
        .selectAll()
        .where('id', '=', githubFile.sourceId)
        .executeTakeFirst();

      if (!source) continue;

      // 獲取 installation token
      const token = await getInstallationToken(source.githubInstallationId);

      // 判斷文件狀態（added/modified/removed）
      if (filesJson.removed.includes(githubFile.path)) {
        // 文件被刪除：軟刪除頁面
        await db
          .updateTable('githubFiles')
          .set({ status: 'deleted', updatedAt: new Date() })
          .where('id', '=', githubFile.id)
          .execute();

        if (githubFile.pageId) {
          const actor = await getDefaultWorkspaceUserId(source.workspaceId);
          if (actor) {
            await pageRepo.removePage(githubFile.pageId, actor);
          }
        }
      } else {
        // 文件新增或修改：重新同步
        // 使用與 handlePush 相同的邏輯
        const contentRes = await githubApi.getContent(
          source.owner,
          source.repo,
          githubFile.path,
          source.ref,
          token
        );

        if (contentRes.status === 200) {
          const base64 = contentRes.body.content as string;
          const md = base64 ? Buffer.from(base64, 'base64').toString('utf-8') : '';

          // Markdown → HTML → TipTap JSON
          const html = await mapper.markdownToHtml(md);
          const rewrite = await rewriter.rewriteHtml(html, {
            owner: source.owner,
            repo: source.repo,
            ref: source.ref,
            token,
            pageDir: githubFile.path.includes('/')
              ? githubFile.path.substring(0, githubFile.path.lastIndexOf('/'))
              : '',
            workspaceId: source.workspaceId,
            spaceId: source.spaceId,
            pageId: githubFile.pageId ?? null,
            creatorId: await getDefaultWorkspaceUserId(source.workspaceId),
          });

          const prosemirrorJson = await mapper.htmlToTipTap(rewrite.html);
          const { title, prosemirrorJson: finalJson } = await mapper.extractTitleAndRemoveHeading(prosemirrorJson);
          const ydocBuf = createYdocFromJson(finalJson);
          const textContent = jsonToText(finalJson);

          // 決定是否鎖定（根據 mode）
          const isLocked = source.mode === 'readonly';

          if (githubFile.pageId) {
            // 更新現有頁面
            await pageRepo.updatePage({
              title,
              content: finalJson,
              textContent,
              ydoc: ydocBuf,
              lastUpdatedById: await getDefaultWorkspaceUserId(source.workspaceId),
              isLocked,
            }, githubFile.pageId);

            // 關閉 collab 連線
            collab.closeDocumentConnections(`page.${githubFile.pageId}`);
          }

          // 更新 github_files 記錄
          await db
            .updateTable('githubFiles')
            .set({
              sha: contentRes.body.sha,
              etag: contentRes.etag ?? null,
              title,
              updatedAt: new Date()
            })
            .where('id', '=', githubFile.id)
            .execute();
        }
      }

      // 標記為已處理
      await db
        .updateTable('githubWebhookEvents')
        .set({
          processed: true,
          deferred: false,
          processedAt: new Date()
        })
        .where('id', '=', event.id)
        .execute();
    } catch (error) {
      logger.error(`Failed to reprocess deferred webhook ${event.id}:`, error);
    }
  }
}
```

### 流程 2：Webhook 處理（帶編輯檢查）

```typescript
async function handlePushWithEditCheck(payload: GitHubPushPayload, deliveryId: string) {
  // ... [前面相同：驗證、記錄 event] ...

  const sources = await findMatchingSources(payload);

  for (const source of sources) {
    // ✅ 只處理 PR workflow 模式的 source
    if (source.mode !== 'pr_workflow') {
      continue;
    }

    const files = await getChangedFiles(payload);

    for (const file of files) {
      const githubFile = await findGithubFileMapping(source.id, file.path);
      if (!githubFile) continue;

      // 🔥 關鍵：檢查是否有任何活動的編輯 session（支援多人協作）
      const hasActiveEdits = await db
        .selectFrom('githubEditSessions')
        .select(['id'])
        .where('githubFileId', '=', githubFile.id)
        .where('isActive', '=', true)
        .executeTakeFirst();

      if (hasActiveEdits) {
        // ❌ 有人正在編輯，跳過同步，記錄為延遲同步

        // 🔥 修正：加入 filesJson，供重新處理時使用
        const filesJson = {
          added: payload.commits?.flatMap((c: any) => c.added || []) || [],
          modified: payload.commits?.flatMap((c: any) => c.modified || []) || [],
          removed: payload.commits?.flatMap((c: any) => c.removed || []) || []
        };

        await db.insertInto('githubWebhookEvents').values({
          githubInstallationId: source.githubInstallationId,
          deliveryId: `${deliveryId}-${file.path}`,
          event: 'push',
          repoFullName: `${source.owner}/${source.repo}`,
          beforeSha: payload.before,
          afterSha: payload.after,
          filesJson: filesJson as any,  // ✅ 加入文件列表
          processed: false,
          deferred: true,
          deferReason: `Page being edited (active sessions detected)`,
        }).execute();

        // 🔔 發送通知給所有編輯者
        const activeEditors = await db
          .selectFrom('githubEditSessions')
          .select(['userId'])
          .where('githubFileId', '=', githubFile.id)
          .where('isActive', '=', true)
          .execute();

        for (const editor of activeEditors) {
          await notifyEditor(editor.userId, {
            type: 'remote_change_detected',
            pageId: githubFile.pageId,
            message: 'GitHub has new changes while you are editing. Please review after finishing.'
          });
        }

        continue; // 跳過這個文件的同步
      }

      // ✅ 沒有活動編輯，檢查是否有 pending changes
      const pendingChange = await db
        .selectFrom('githubPendingChanges')
        .selectAll()
        .where('githubFileId', '=', githubFile.id)
        .executeTakeFirst();

      if (pendingChange) {
        // ⚠️ 有未推送的修改，標記為衝突
        await db
          .updateTable('githubPendingChanges')
          .set({
            hasConflict: true,
            remoteSha: payload.after,
            conflictCheckedAt: new Date()
          })
          .where('id', '=', pendingChange.id)
          .execute();

        // 🔔 通知創建者
        await notifyUser(pendingChange.createdBy, {
          type: 'conflict_detected',
          pageId: githubFile.pageId,
          message: 'Your changes conflict with new GitHub commits. Please resolve before creating PR.'
        });

        continue; // 跳過同步
      }

      // ✅ 安全：沒有編輯也沒有 pending changes，正常同步
      await syncFileFromGitHub(source, file, githubFile);
    }
  }
}
```

### 流程 3：檢測內容變更

```typescript
async function checkPageModified(pageId: string): Promise<boolean> {
  // 1. 獲取編輯 session 的初始快照
  const session = await db
    .selectFrom('githubEditSessions')
    .select(['snapshotContent'])
    .where('pageId', '=', pageId)
    .where('isActive', '=', true)
    .executeTakeFirst();

  if (!session) return false;

  // 2. 獲取當前頁面內容
  const currentPage = await db
    .selectFrom('pages')
    .select(['content'])
    .where('id', '=', pageId)
    .executeTakeFirst();

  if (!currentPage) return false;

  // 3. 比對 hash（避免深度比對大型 JSON）
  const snapshotHash = hashContent(session.snapshotContent);
  const currentHash = hashContent(currentPage.content);

  return snapshotHash !== currentHash;
}

function hashContent(content: any): string {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(content))
    .digest('hex');
}
```

### 流程 4：創建 Pending Change

```typescript
async function createPendingChange(pageId: string, userId: string, baseSha?: string) {
  // 1. 獲取頁面相關資訊
  const page = await db
    .selectFrom('pages')
    .selectAll()
    .where('id', '=', pageId)
    .executeTakeFirst();

  const githubFile = await db
    .selectFrom('githubFiles')
    .selectAll()
    .where('pageId', '=', pageId)
    .executeTakeFirst();

  if (!page || !githubFile) return;

  // 2. 確定變更類型
  const changeType = githubFile.status === 'synced' ? 'update' : 'create';

  // 🔥 修正：使用傳入的 baseSha（來自 edit session），而非當前的 githubFile.sha
  // 這樣才能正確檢測衝突（基於開始編輯時的版本，而非最新版本）
  const effectiveBaseSha = baseSha ?? githubFile.sha;

  // 3. 創建 pending change 記錄
  await db
    .insertInto('githubPendingChanges')
    .values({
      sourceId: githubFile.sourceId,
      githubFileId: githubFile.id,
      pageId: page.id,
      changeType,
      baseSha: effectiveBaseSha,        // ✅ 使用正確的 base SHA
      currentContent: page.content,
      createdBy: userId,
    })
    .onConflict((oc) =>
      oc.column('githubFileId').doUpdateSet({
        baseSha: effectiveBaseSha,      // ✅ 更新時也使用正確的 SHA
        currentContent: page.content,
        updatedAt: new Date()
      })
    )
    .execute();

  // 4. 更新 github_files 標記
  await db
    .updateTable('githubFiles')
    .set({ hasLocalChanges: true })
    .where('id', '=', githubFile.id)
    .execute();
}
```

### 流程 5：檢查遠端變更（衝突檢測）

```typescript
async function checkRemoteChanges(pageId: string): Promise<ConflictStatus> {
  // 1. 獲取 pending change
  const pending = await db
    .selectFrom('githubPendingChanges as pc')
    .innerJoin('githubFiles as gf', 'gf.id', 'pc.githubFileId')
    .innerJoin('githubSources as gs', 'gs.id', 'gf.sourceId')
    .selectAll('pc')
    .select(['gf.path', 'gs.owner', 'gs.repo', 'gs.ref', 'gs.githubInstallationId'])
    .where('pc.pageId', '=', pageId)
    .executeTakeFirst();

  if (!pending) return { hasConflict: false };

  // 🔥 修正：改為文件級別檢測，而非分支 HEAD 比對
  const token = await getInstallationToken(pending.githubInstallationId);

  // 2. 獲取該文件的最新內容和 SHA
  const fileContent = await githubApi.getContent(
    pending.owner,
    pending.repo,
    pending.path,
    pending.ref,
    token
  );

  if (fileContent.status === 404) {
    // 文件已被刪除
    await db
      .updateTable('githubPendingChanges')
      .set({
        hasConflict: true,
        remoteSha: null,
        conflictCheckedAt: new Date()
      })
      .where('id', '=', pending.id)
      .execute();

    return {
      hasConflict: true,
      baseSha: pending.baseSha,
      remoteSha: null,
      conflictReason: 'file_deleted_on_remote'
    };
  }

  const remoteSha = fileContent.body.sha;

  // 3. 比對文件的 SHA（只要文件本身沒變就不算衝突）
  if (remoteSha === pending.baseSha) {
    // ✅ 該文件沒有新的變更
    return { hasConflict: false };
  }

  // 4. ⚠️ 該文件確實有變更，標記為衝突
  await db
    .updateTable('githubPendingChanges')
    .set({
      hasConflict: true,
      remoteSha: remoteSha,
      conflictCheckedAt: new Date()
    })
    .where('id', '=', pending.id)
    .execute();

  // 🔥 Base64 解碼（衝突 UI 可讀）
  let remoteContentDecoded: string | undefined;
  try {
    if (fileContent.body.content) {
      remoteContentDecoded = Buffer.from(fileContent.body.content, 'base64').toString('utf-8');
    }
  } catch (err) {
    logger.warn(`Failed to decode base64 content for ${pending.path}`, err);
    remoteContentDecoded = fileContent.body.content; // 保留 base64 作為備用
  }

  return {
    hasConflict: true,
    baseSha: pending.baseSha,
    remoteSha: remoteSha,
    localContent: pending.currentContent,
    remoteContent: remoteContentDecoded || fileContent.body.content,  // ✅ 解碼後的內容
    remoteContentBase64: fileContent.body.content,  // 保留原始 base64 供特殊情況使用
  };
}
```

### 流程 6：創建 PR（主流程）

```typescript
interface CreatePRRequest {
  sourceId: string;
  fileIds: string[];            // 要包含哪些 pending changes
  commitMessage: string;
  commitDescription?: string;
  userId: string;
}

async function createPullRequest(req: CreatePRRequest): Promise<CreatePRResult> {
  // ========== 階段 1：驗證與準備 ==========

  // 1.1 獲取 source 資訊
  const source = await db
    .selectFrom('githubSources')
    .selectAll()
    .where('id', '=', req.sourceId)
    .where('mode', '=', 'pr_workflow')
    .executeTakeFirst();

  if (!source) {
    throw new Error('Source not found or not in PR workflow mode');
  }

  // 1.2 獲取所有 pending changes
  const pendingChanges = await db
    .selectFrom('githubPendingChanges')
    .innerJoin('githubFiles', 'githubFiles.id', 'githubPendingChanges.githubFileId')
    .selectAll('githubPendingChanges')
    .select(['githubFiles.path', 'githubFiles.title'])
    .where('githubPendingChanges.id', 'in', req.fileIds)
    .where('githubPendingChanges.sourceId', '=', req.sourceId)
    .execute();

  // 1.3 檢查是否有衝突
  const conflicts = pendingChanges.filter(pc => pc.hasConflict);
  if (conflicts.length > 0) {
    throw new ConflictError(
      `Cannot create PR: ${conflicts.length} file(s) have conflicts. Please resolve first.`,
      conflicts.map(c => c.path)
    );
  }

  // 1.4 檢查是否有活動的編輯 session
  const activeEdits = await db
    .selectFrom('githubEditSessions')
    .select(['pageId'])
    .where('isActive', '=', true)
    .where('pageId', 'in', pendingChanges.map(pc => pc.pageId))
    .execute();

  if (activeEdits.length > 0) {
    throw new Error('Cannot create PR: some pages are still being edited');
  }

  // ========== 階段 2：轉換內容 ==========

  const filesToPush: Array<{
    path: string;
    content: string;      // Base64 encoded
    sha?: string;         // 用於更新現有文件
  }> = [];

  for (const change of pendingChanges) {
    // 2.1 TipTap JSON → Markdown
    const markdown = await convertTipTapToMarkdown(change.currentContent);

    // 2.2 處理內部連結（轉換為相對路徑）
    const processedMarkdown = await processInternalLinks(markdown, {
      sourceId: req.sourceId,
      currentPath: change.path
    });

    // 2.3 處理附件（下載並上傳到 GitHub）
    const { markdown: finalMarkdown, uploadedFiles } = await processAttachments(
      processedMarkdown,
      {
        source,
        basePath: change.path,
        token: await getInstallationToken(source.githubInstallationId)
      }
    );

    filesToPush.push({
      path: change.path,
      content: Buffer.from(finalMarkdown, 'utf-8').toString('base64'),
      sha: change.changeType === 'update' ? change.baseSha : undefined
    });

    // 附件也需要上傳
    filesToPush.push(...uploadedFiles);
  }

  // ========== 階段 3：創建分支 ==========

  const token = await getInstallationToken(source.githubInstallationId);
  const branchName = `${source.prBranchPrefix || 'docmost-sync'}/${Date.now()}-${generateShortId()}`;

  // 3.1 獲取 main branch 的最新 commit SHA
  const mainBranch = await githubApi.getBranch(
    source.owner,
    source.repo,
    source.ref,
    token
  );

  // 3.2 創建新分支（基於 main 的最新 commit）
  await githubApi.createBranch(
    source.owner,
    source.repo,
    branchName,
    mainBranch.commit.sha,
    token
  );

  // ========== 階段 4：推送文件 ==========

  for (const file of filesToPush) {
    try {
      // 🔥 推送前 SHA 驗證（防止 race condition）
      if (file.sha) {
        // 驗證 baseSha 是否仍然是最新的
        const currentFileOnGithub = await githubApi.getContent(
          source.owner,
          source.repo,
          file.path,
          source.ref,
          token
        );

        if (currentFileOnGithub.status === 200 && currentFileOnGithub.body?.sha !== file.sha) {
          // SHA 已經改變，表示有 race condition
          logger.warn(`Pre-push SHA mismatch for ${file.path}. Expected: ${file.sha}, Got: ${currentFileOnGithub.body?.sha}`);

          // 標記為衝突並中止推送
          const pendingChange = pendingChanges.find(pc => pc.path === file.path);
          if (pendingChange) {
            await db
              .updateTable('githubPendingChanges')
              .set({
                hasConflict: true,
                conflictReason: 'sha_changed_during_push',
                remoteSha: currentFileOnGithub.body?.sha,
                updatedAt: new Date()
              })
              .where('id', '=', pendingChange.id)
              .execute();
          }

          throw new Error(`SHA mismatch for ${file.path} - file was modified on GitHub during PR creation`);
        }
      }

      await githubApi.createOrUpdateFile(
        source.owner,
        source.repo,
        file.path,
        {
          message: `Update ${file.path}`,  // 單個文件的 commit message
          content: file.content,
          branch: branchName,
          sha: file.sha,  // 如果是更新，需要提供 sha
        },
        token
      );
    } catch (error) {
      // 如果推送失敗，記錄錯誤並繼續（或回滾整個分支？）
      logger.error(`Failed to push file ${file.path}:`, error);
      throw new Error(`Failed to push file ${file.path}: ${error.message}`);
    }
  }

  // ========== 階段 5：創建 Pull Request ==========

  const prBody = buildPRDescription({
    changes: pendingChanges,
    commitDescription: req.commitDescription,
    author: await getUserName(req.userId),
  });

  const pr = await githubApi.createPullRequest(
    source.owner,
    source.repo,
    {
      title: req.commitMessage,
      body: prBody,
      head: branchName,
      base: source.ref,  // 通常是 'main'
    },
    token
  );

  // ========== 階段 6：記錄 PR 批次 ==========

  const prBatch = await db
    .insertInto('githubPrBatches')
    .values({
      sourceId: req.sourceId,
      branchName,
      prNumber: pr.number,
      prUrl: pr.html_url,
      prStatus: 'open',
      fileIds: req.fileIds,
      fileCount: pendingChanges.length,
      commitMessage: req.commitMessage,
      commitDescription: req.commitDescription,
      createdBy: req.userId,
      pushedAt: new Date(),
    })
    .returningAll()
    .executeTakeFirst();

  // ========== 階段 7：清理 Pending Changes ==========

  for (const change of pendingChanges) {
    // 7.1 刪除 pending change 記錄
    await db
      .deleteFrom('githubPendingChanges')
      .where('id', '=', change.id)
      .execute();

    // 7.2 更新 github_files
    await db
      .updateTable('githubFiles')
      .set({
        hasLocalChanges: false,
        githubPrUrl: pr.html_url,
        updatedAt: new Date()
      })
      .where('id', '=', change.githubFileId)
      .execute();
  }

  // ========== 階段 8：返回結果 ==========

  return {
    success: true,
    prNumber: pr.number,
    prUrl: pr.html_url,
    branchName,
    filesCount: pendingChanges.length,
  };
}

// ========== 輔助函數 ==========

function buildPRDescription(params: {
  changes: Array<{ path: string; title: string; changeType: string }>;
  commitDescription?: string;
  author: string;
}): string {
  const { changes, commitDescription, author } = params;

  const changesByType = {
    create: changes.filter(c => c.changeType === 'create'),
    update: changes.filter(c => c.changeType === 'update'),
    delete: changes.filter(c => c.changeType === 'delete'),
  };

  let body = `## 📝 Changes from Docmost\n\n`;
  body += `**Author:** ${author}\n`;
  body += `**Files changed:** ${changes.length}\n\n`;

  if (commitDescription) {
    body += `### Description\n${commitDescription}\n\n`;
  }

  body += `### Changed Files\n\n`;

  if (changesByType.create.length > 0) {
    body += `#### ✨ Created (${changesByType.create.length})\n`;
    for (const c of changesByType.create) {
      body += `- ${c.path} - ${c.title}\n`;
    }
    body += `\n`;
  }

  if (changesByType.update.length > 0) {
    body += `#### ✏️ Updated (${changesByType.update.length})\n`;
    for (const c of changesByType.update) {
      body += `- ${c.path} - ${c.title}\n`;
    }
    body += `\n`;
  }

  if (changesByType.delete.length > 0) {
    body += `#### 🗑️ Deleted (${changesByType.delete.length})\n`;
    for (const c of changesByType.delete) {
      body += `- ${c.path}\n`;
    }
    body += `\n`;
  }

  body += `\n---\n`;
  body += `🤖 This PR was automatically created by [Docmost](https://docmost.com)\n`;

  return body;
}
```

### 流程 7：TipTap JSON → Markdown 轉換

```typescript
// apps/server/src/integrations/github/github.markdown-serializer.ts

import { Node } from '@tiptap/core';

export class TipTapMarkdownSerializer {

  async serialize(doc: any): Promise<string> {
    if (!doc || doc.type !== 'doc') {
      throw new Error('Invalid TipTap document');
    }

    let markdown = '';

    for (const node of doc.content || []) {
      markdown += this.serializeNode(node) + '\n\n';
    }

    return markdown.trim();
  }

  private serializeNode(node: any, context?: SerializeContext): string {
    const handler = this.nodeHandlers[node.type];

    if (!handler) {
      console.warn(`Unknown node type: ${node.type}`);
      return '';
    }

    return handler.call(this, node, context);
  }

  private nodeHandlers: Record<string, (node: any, ctx?: SerializeContext) => string> = {
    // ========== Block Nodes ==========

    paragraph: (node) => {
      const content = this.serializeInlineContent(node.content || []);
      return content;
    },

    heading: (node) => {
      const level = node.attrs?.level || 1;
      const content = this.serializeInlineContent(node.content || []);
      return '#'.repeat(level) + ' ' + content;
    },

    bulletList: (node) => {
      return (node.content || [])
        .map((item: any) => this.serializeNode(item, { listType: 'bullet' }))
        .join('\n');
    },

    orderedList: (node) => {
      return (node.content || [])
        .map((item: any, index: number) =>
          this.serializeNode(item, { listType: 'ordered', listIndex: index + 1 })
        )
        .join('\n');
    },

    listItem: (node, ctx) => {
      const prefix = ctx?.listType === 'ordered'
        ? `${ctx.listIndex}. `
        : '- ';

      const content = (node.content || [])
        .map((n: any) => this.serializeNode(n))
        .join('\n');

      return prefix + content;
    },

    codeBlock: (node) => {
      const language = node.attrs?.language || '';
      const code = node.content?.[0]?.text || '';
      return '```' + language + '\n' + code + '\n```';
    },

    blockquote: (node) => {
      const content = (node.content || [])
        .map((n: any) => this.serializeNode(n))
        .join('\n');

      return content.split('\n').map(line => '> ' + line).join('\n');
    },

    horizontalRule: () => {
      return '---';
    },

    table: (node) => {
      const rows = node.content || [];

      if (rows.length === 0) return '';

      // 第一行作為 header
      const headerRow = rows[0];
      const headerCells = (headerRow.content || []).map((cell: any) =>
        this.serializeInlineContent(cell.content || [])
      );

      let markdown = '| ' + headerCells.join(' | ') + ' |\n';
      markdown += '| ' + headerCells.map(() => '---').join(' | ') + ' |\n';

      // 其他行
      for (let i = 1; i < rows.length; i++) {
        const row = rows[i];
        const cells = (row.content || []).map((cell: any) =>
          this.serializeInlineContent(cell.content || [])
        );
        markdown += '| ' + cells.join(' | ') + ' |\n';
      }

      return markdown;
    },

    // ========== Inline Nodes ==========

    text: (node) => {
      let text = node.text || '';

      // 處理 marks（粗體、斜體等）
      if (node.marks) {
        for (const mark of node.marks) {
          text = this.applyMark(text, mark);
        }
      }

      return text;
    },

    hardBreak: () => {
      return '\n';
    },

    image: (node) => {
      const src = node.attrs?.src || '';
      const alt = node.attrs?.alt || '';
      const title = node.attrs?.title;

      if (title) {
        return `![${alt}](${src} "${title}")`;
      }
      return `![${alt}](${src})`;
    },

    // ========== Custom Nodes (Docmost specific) ==========

    callout: (node) => {
      // Callout 在標準 Markdown 不支援，轉換為 blockquote
      const type = node.attrs?.type || 'info';
      const emoji = { info: 'ℹ️', warning: '⚠️', error: '❌', success: '✅' }[type] || 'ℹ️';

      const content = (node.content || [])
        .map((n: any) => this.serializeNode(n))
        .join('\n');

      return `> ${emoji} **${type.toUpperCase()}**\n> \n> ${content.replace(/\n/g, '\n> ')}`;
    },

    details: (node) => {
      // Details 使用 HTML（GitHub 支援）
      const summary = node.attrs?.summary || 'Details';
      const content = (node.content || [])
        .map((n: any) => this.serializeNode(n))
        .join('\n\n');

      return `<details>\n<summary>${summary}</summary>\n\n${content}\n\n</details>`;
    },
  };

  private serializeInlineContent(nodes: any[]): string {
    return nodes.map(node => this.serializeNode(node)).join('');
  }

  private applyMark(text: string, mark: any): string {
    switch (mark.type) {
      case 'bold':
        return `**${text}**`;
      case 'italic':
        return `*${text}*`;
      case 'code':
        return `\`${text}\``;
      case 'strike':
        return `~~${text}~~`;
      case 'link':
        const href = mark.attrs?.href || '';
        return `[${text}](${href})`;
      case 'highlight':
        // Markdown 不支援 highlight，使用 HTML
        return `<mark>${text}</mark>`;
      default:
        return text;
    }
  }
}

interface SerializeContext {
  listType?: 'bullet' | 'ordered';
  listIndex?: number;
}
```

### 流程 8：處理內部連結

```typescript
async function processInternalLinks(markdown: string, context: {
  sourceId: string;
  currentPath: string;
}): Promise<string> {

  // Docmost 內部連結格式：[title](/w/{workspaceId}/s/{spaceId}/p/{pageSlugId})
  const internalLinkPattern = /\[([^\]]+)\]\(\/w\/[^\/]+\/s\/[^\/]+\/p\/([^\)]+)\)/g;

  let processedMarkdown = markdown;
  const matches = [...markdown.matchAll(internalLinkPattern)];

  for (const match of matches) {
    const [fullMatch, linkText, pageSlugId] = match;

    // 1. 查找該頁面對應的 GitHub 文件
    const targetFile = await db
      .selectFrom('pages')
      .innerJoin('githubFiles', 'githubFiles.pageId', 'pages.id')
      .select(['githubFiles.path'])
      .where('pages.slugId', '=', pageSlugId)
      .where('githubFiles.sourceId', '=', context.sourceId)
      .executeTakeFirst();

    if (targetFile) {
      // 2. 計算相對路徑
      const relativePath = calculateRelativePath(context.currentPath, targetFile.path);

      // 3. 替換為相對連結
      processedMarkdown = processedMarkdown.replace(
        fullMatch,
        `[${linkText}](${relativePath})`
      );
    } else {
      // 4. 無法找到對應文件，保留原連結但加上註解
      processedMarkdown = processedMarkdown.replace(
        fullMatch,
        `[${linkText}](${fullMatch}) <!-- Warning: Link target not found in GitHub -->`
      );
    }
  }

  return processedMarkdown;
}

function calculateRelativePath(from: string, to: string): string {
  // from: "docs/api/authentication.md"
  // to: "docs/guides/getting-started.md"
  // result: "../guides/getting-started.md"

  const fromParts = from.split('/').slice(0, -1); // 去掉檔案名
  const toParts = to.split('/');

  let commonDepth = 0;
  for (let i = 0; i < Math.min(fromParts.length, toParts.length); i++) {
    if (fromParts[i] === toParts[i]) {
      commonDepth++;
    } else {
      break;
    }
  }

  const upLevels = fromParts.length - commonDepth;
  const downPath = toParts.slice(commonDepth);

  const relativePath = '../'.repeat(upLevels) + downPath.join('/');

  return relativePath || './'; // 同一目錄
}
```

### 流程 9：處理附件上傳

```typescript
async function processAttachments(
  markdown: string,
  context: {
    source: GithubSource;
    basePath: string;
    token: string;
  }
): Promise<{ markdown: string; uploadedFiles: Array<{ path: string; content: string; sha?: string }> }> {

  const uploadedFiles: Array<{ path: string; content: string; sha?: string }> = [];

  // 🔥 Asset SHA 處理：查找現有附件的 SHA
  const existingAssets = await db
    .selectFrom('githubFiles')
    .select(['path', 'sha'])
    .where('sourceId', '=', context.source.id)
    .where('contentType', '=', 'asset')
    .execute();

  const assetShaMap = new Map(existingAssets.map(a => [a.path, a.sha]));

  // Docmost 附件連結格式：/api/files/{attachmentId}/{fileName}
  const attachmentPattern = /!\[([^\]]*)\]\((\/api\/files\/([^\/]+)\/([^\)]+))\)/g;

  let processedMarkdown = markdown;
  const matches = [...markdown.matchAll(attachmentPattern)];

  for (const match of matches) {
    const [fullMatch, altText, fullUrl, attachmentId, fileName] = match;

    // 1. 從 Docmost 下載附件
    const attachment = await db
      .selectFrom('attachments')
      .select(['fileUrl', 'mimeType'])
      .where('id', '=', attachmentId)
      .executeTakeFirst();

    if (!attachment) {
      console.warn(`Attachment not found: ${attachmentId}`);
      continue;
    }

    // 2. 讀取附件內容
    const fileBuffer = await storageService.readFile(attachment.fileUrl);
    const base64Content = fileBuffer.toString('base64');

    // 3. 決定 GitHub 中的路徑
    // 策略：在同一目錄下創建 assets 子目錄
    // 例如：docs/api/authentication.md → docs/api/assets/image.png
    const pathDir = context.basePath.includes('/')
      ? context.basePath.substring(0, context.basePath.lastIndexOf('/'))
      : '';

    const assetPath = pathDir
      ? `${pathDir}/assets/${fileName}`
      : `assets/${fileName}`;

    // 4. 記錄要上傳的文件（包含 SHA，如果附件已存在）
    uploadedFiles.push({
      path: assetPath,
      content: base64Content,
      sha: assetShaMap.get(assetPath)  // ✅ 包含現有 SHA（如果存在）
    });

    // 5. 計算相對路徑並替換
    const relativePath = calculateRelativePath(context.basePath, assetPath);
    processedMarkdown = processedMarkdown.replace(
      fullMatch,
      `![${altText}](${relativePath})`
    );
  }

  return { markdown: processedMarkdown, uploadedFiles };
}
```

### 流程 10：修改現有同步代碼（isLocked 條件化）

**重要：** 需要修改 `github.sync.service.ts` 的 `fullSync()` 和 `handlePush()` 函數

```typescript
// apps/server/src/integrations/github/github.sync.service.ts

async fullSync(workspaceId: string, sourceId: string, opts?: { force?: boolean; jobId?: string }) {
  const source = await this.db
    .selectFrom('githubSources')
    .selectAll()
    .where('id', '=', sourceId)
    .where('workspaceId', '=', workspaceId)
    .executeTakeFirst();

  if (!source) {
    throw new NotFoundException('Source not found');
  }

  // 🔥 關鍵修改：根據 mode 決定是否鎖定頁面
  const isLocked = source.mode === 'readonly';  // 只有 readonly 才鎖定

  // ... [獲取文件列表、轉換內容] ...

  for (const file of files) {
    // ... [內容轉換邏輯] ...

    if (existing?.pageId) {
      // 更新現有頁面
      await this.pageRepo.updatePage(
        {
          title,
          content: finalJson,
          textContent,
          ydoc: ydocBuf,
          lastUpdatedById: await this.getDefaultWorkspaceUserId(workspaceId),
          isLocked,  // ✅ 條件化設置
        },
        existing.pageId,
      );
    } else {
      // 創建新頁面
      const created = await this.pageRepo.insertPage({
        slugId: generateSlugId(),
        title,
        content: finalJson,
        textContent,
        ydoc: ydocBuf,
        position,
        parentPageId: folderPageId ?? source.rootPageId ?? null,
        spaceId: source.spaceId,
        creatorId: await this.getDefaultWorkspaceUserId(workspaceId),
        workspaceId,
        lastUpdatedById: await this.getDefaultWorkspaceUserId(workspaceId),
        isLocked,  // ✅ 條件化設置
      });
    }
  }
}

async handlePush(payload: any, deliveryId: string) {
  // ... [前面的邏輯] ...

  for (const source of sources) {
    // 🔥 新增：PR workflow 模式需要檢查編輯鎖
    if (source.mode === 'pr_workflow') {
      const hasActiveEdits = await this.db
        .selectFrom('githubEditSessions')
        .select(['id'])
        .where('githubFileId', '=', githubFile.id)
        .where('isActive', '=', true)
        .executeTakeFirst();

      if (hasActiveEdits) {
        // 跳過同步，記錄為延遲
        await this.recordDeferredWebhook(deliveryId, source, file);
        continue;
      }
    }

    // 🔥 關鍵修改：根據 mode 決定是否鎖定
    const isLocked = source.mode === 'readonly';

    const files = await this.getChangedFiles(payload);

    for (const file of files) {
      // ... [處理文件變更] ...

      if (existing?.pageId) {
        await this.pageRepo.updatePage(
          {
            title,
            content: finalJson,
            textContent,
            ydoc: ydocBuf,
            lastUpdatedById: await this.getDefaultWorkspaceUserId(source.workspaceId),
            isLocked,  // ✅ 條件化設置
          },
          existing.pageId,
        );
      } else {
        const created = await this.pageRepo.insertPage({
          // ... [其他欄位] ...
          isLocked,  // ✅ 條件化設置
        });
      }
    }
  }
}
```

**測試檢查點：**
1. ✅ `mode='readonly'` 的 source → 頁面 `isLocked=true`（無法編輯）
2. ✅ `mode='pr_workflow'` 的 source → 頁面 `isLocked=false`（可編輯）
3. ✅ PR mode 頁面可以正常開啟編輯器
4. ✅ 編輯時 webhook 不會覆蓋內容

---

## API 設計

### 1. 獲取編輯狀態

```typescript
GET /api/integrations/github/pages/:pageId/edit-status

Response:
{
  isGithubManaged: boolean,
  mode: 'readonly' | 'pr_workflow',
  editStatus: {
    isEditing: boolean,
    editedBy?: { id: string, name: string },
    editStartedAt?: string,
    baseSha?: string
  },
  pendingChange?: {
    id: string,
    hasConflict: boolean,
    changeType: 'create' | 'update' | 'delete',
    createdAt: string
  },
  remoteStatus: {
    latestSha: string,
    isSynced: boolean,
    lastSyncedAt?: string
  }
}
```

### 2. 開始/結束編輯

```typescript
POST /api/integrations/github/pages/:pageId/edit/start

Request: { userId: string }

Response: {
  success: boolean,
  sessionId: string,
  baseSha: string
}

---

POST /api/integrations/github/pages/:pageId/edit/end

Request: {
  sessionId: string,
  userId: string
}

Response: {
  success: boolean,
  hasChanges: boolean,
  pendingChangeId?: string
}
```

### 3. 獲取待推送變更

```typescript
GET /api/integrations/github/sources/:sourceId/pending-changes

Response: {
  changes: Array<{
    id: string,
    pageId: string,
    pageTitle: string,
    filePath: string,
    changeType: 'create' | 'update' | 'delete',
    hasConflict: boolean,
    baseSha: string,
    remoteSha?: string,
    createdBy: { id: string, name: string },
    createdAt: string,
    preview?: {
      addedLines: number,
      removedLines: number
    }
  }>,
  totalCount: number
}
```

### 4. 預覽 Markdown 轉換

```typescript
POST /api/integrations/github/preview-markdown

Request: {
  pageId: string
}

Response: {
  markdown: string,
  warnings: Array<{
    type: 'unsupported_feature' | 'broken_link' | 'missing_attachment',
    message: string,
    line?: number
  }>
}
```

### 5. 檢查衝突

```typescript
POST /api/integrations/github/pending-changes/:id/check-conflict

Response: {
  hasConflict: boolean,
  conflictDetails?: {
    baseSha: string,
    remoteSha: string,
    localContent: any,
    remoteContent: string,  // Base64
    diff: {
      added: string[],
      removed: string[],
      conflicting: string[]
    }
  }
}
```

### 6. 創建 PR

```typescript
POST /api/integrations/github/sources/:sourceId/create-pr

Request: {
  changeIds: string[],        // 要包含哪些 pending changes
  commitMessage: string,
  commitDescription?: string
}

Response: {
  success: boolean,
  prNumber: number,
  prUrl: string,
  branchName: string,
  filesCount: number,
  errors?: Array<{
    fileId: string,
    filePath: string,
    error: string
  }>
}
```

### 7. PR 歷史

```typescript
GET /api/integrations/github/sources/:sourceId/pr-history

Query: {
  status?: 'open' | 'merged' | 'closed',
  limit?: number,
  offset?: number
}

Response: {
  prs: Array<{
    id: string,
    prNumber: number,
    prUrl: string,
    branchName: string,
    status: string,
    filesCount: number,
    commitMessage: string,
    createdBy: { id: string, name: string },
    createdAt: string,
    mergedAt?: string
  }>,
  total: number
}
```

---

## 前端實現

### 1. 頁面編輯狀態指示器

```tsx
// apps/client/src/features/github/components/GithubEditStatus.tsx

import { useEffect, useState } from 'react';
import { Badge, Group, Tooltip, ActionIcon, Alert } from '@mantine/core';
import { IconBrandGithub, IconAlertTriangle, IconRefresh } from '@tabler/icons-react';
import { useQuery, useMutation } from '@tanstack/react-query';

interface GithubEditStatusProps {
  pageId: string;
}

export function GithubEditStatus({ pageId }: GithubEditStatusProps) {
  const { data: status, refetch } = useQuery({
    queryKey: ['github-edit-status', pageId],
    queryFn: () => githubApi.getEditStatus(pageId),
    refetchInterval: 30000, // 每 30 秒檢查一次
  });

  if (!status?.isGithubManaged) return null;

  const { editStatus, pendingChange, remoteStatus } = status;

  // 決定顯示狀態
  const displayStatus = getDisplayStatus(status);

  return (
    <Group gap="xs">
      <Tooltip label="This page is synced with GitHub">
        <IconBrandGithub size={16} />
      </Tooltip>

      <Badge
        color={displayStatus.color}
        variant="light"
        leftSection={displayStatus.icon}
      >
        {displayStatus.text}
      </Badge>

      {pendingChange?.hasConflict && (
        <Tooltip label="Conflict detected - remote changes exist">
          <ActionIcon
            color="orange"
            variant="light"
            onClick={() => handleConflictResolve()}
          >
            <IconAlertTriangle size={16} />
          </ActionIcon>
        </Tooltip>
      )}

      {!remoteStatus.isSynced && (
        <Tooltip label="Check for remote updates">
          <ActionIcon
            variant="light"
            onClick={() => refetch()}
          >
            <IconRefresh size={16} />
          </ActionIcon>
        </Tooltip>
      )}
    </Group>
  );
}

function getDisplayStatus(status: any) {
  if (status.pendingChange?.hasConflict) {
    return {
      text: 'Conflict',
      color: 'orange',
      icon: <IconAlertTriangle size={12} />
    };
  }

  if (status.pendingChange) {
    return {
      text: 'Modified',
      color: 'blue',
      icon: null
    };
  }

  if (!status.remoteStatus.isSynced) {
    return {
      text: 'Out of sync',
      color: 'yellow',
      icon: null
    };
  }

  return {
    text: 'Synced',
    color: 'green',
    icon: null
  };
}
```

### 2. 推送到 GitHub 按鈕（整合到 PageHeader）

```tsx
// apps/client/src/features/page/components/header/GithubPushButton.tsx

import { Button, Menu } from '@mantine/core';
import { IconBrandGithub, IconGitPullRequest, IconAlertCircle } from '@tabler/icons-react';
import { useQuery } from '@tanstack/react-query';
import { modals } from '@mantine/modals';

interface GithubPushButtonProps {
  pageId: string;
}

export function GithubPushButton({ pageId }: GithubPushButtonProps) {
  const { data: status } = useQuery({
    queryKey: ['github-edit-status', pageId],
    queryFn: () => githubApi.getEditStatus(pageId),
  });

  if (!status?.isGithubManaged || status.mode !== 'pr_workflow') {
    return null;
  }

  const hasPendingChange = !!status.pendingChange;
  const hasConflict = status.pendingChange?.hasConflict;

  const handlePush = () => {
    if (hasConflict) {
      modals.open({
        title: 'Conflict Detected',
        children: <ConflictResolutionModal pageId={pageId} />,
      });
    } else {
      modals.open({
        title: 'Create Pull Request',
        children: <CreatePRModal pageId={pageId} />,
      });
    }
  };

  return (
    <Menu>
      <Menu.Target>
        <Button
          leftSection={<IconBrandGithub size={16} />}
          variant={hasPendingChange ? 'filled' : 'light'}
          color={hasConflict ? 'orange' : 'blue'}
          disabled={!hasPendingChange}
        >
          {hasPendingChange ? 'Push to GitHub' : 'No changes'}
        </Button>
      </Menu.Target>

      <Menu.Dropdown>
        <Menu.Item
          leftSection={<IconGitPullRequest size={16} />}
          onClick={handlePush}
          disabled={!hasPendingChange}
        >
          Create Pull Request
        </Menu.Item>

        {hasConflict && (
          <Menu.Item
            leftSection={<IconAlertCircle size={16} />}
            color="orange"
          >
            Resolve Conflict First
          </Menu.Item>
        )}
      </Menu.Dropdown>
    </Menu>
  );
}
```

### 3. PR 創建 Modal

```tsx
// apps/client/src/features/github/components/CreatePRModal.tsx

import { useState } from 'react';
import { Stack, TextInput, Textarea, Button, Group, Alert, Code, Loader } from '@mantine/core';
import { useQuery, useMutation } from '@tanstack/react-query';
import { IconBrandGithub, IconCheck, IconAlertTriangle } from '@tabler/icons-react';

interface CreatePRModalProps {
  pageId: string;
}

export function CreatePRModal({ pageId }: CreatePRModalProps) {
  const [commitMessage, setCommitMessage] = useState('');
  const [commitDescription, setCommitDescription] = useState('');

  // 獲取該頁面的 source 和 pending changes
  const { data: pageStatus } = useQuery({
    queryKey: ['github-edit-status', pageId],
    queryFn: () => githubApi.getEditStatus(pageId),
  });

  const { data: pendingChanges } = useQuery({
    queryKey: ['github-pending-changes', pageStatus?.sourceId],
    queryFn: () => githubApi.getPendingChanges(pageStatus!.sourceId!),
    enabled: !!pageStatus?.sourceId,
  });

  // 預覽 Markdown
  const { data: preview, isLoading: isLoadingPreview } = useQuery({
    queryKey: ['github-markdown-preview', pageId],
    queryFn: () => githubApi.previewMarkdown(pageId),
  });

  // 創建 PR mutation
  const createPRMutation = useMutation({
    mutationFn: (data: any) => githubApi.createPR(data),
    onSuccess: (result) => {
      notifications.show({
        title: 'PR Created Successfully',
        message: `Pull Request #${result.prNumber} has been created`,
        color: 'green',
        icon: <IconCheck />,
      });

      // 打開 GitHub PR 頁面
      window.open(result.prUrl, '_blank');

      modals.closeAll();
    },
    onError: (error: any) => {
      notifications.show({
        title: 'Failed to Create PR',
        message: error.message,
        color: 'red',
        icon: <IconAlertTriangle />,
      });
    },
  });

  const handleSubmit = () => {
    if (!commitMessage.trim()) {
      notifications.show({
        message: 'Please enter a commit message',
        color: 'red',
      });
      return;
    }

    createPRMutation.mutate({
      sourceId: pageStatus!.sourceId,
      changeIds: [pageStatus!.pendingChange!.id],
      commitMessage: commitMessage.trim(),
      commitDescription: commitDescription.trim() || undefined,
    });
  };

  return (
    <Stack>
      <Alert icon={<IconBrandGithub />} title="Create Pull Request" color="blue">
        This will create a new branch and Pull Request on GitHub
      </Alert>

      <TextInput
        label="Commit Message"
        placeholder="Update documentation"
        required
        value={commitMessage}
        onChange={(e) => setCommitMessage(e.target.value)}
      />

      <Textarea
        label="Description (optional)"
        placeholder="Additional details about this change..."
        minRows={3}
        value={commitDescription}
        onChange={(e) => setCommitDescription(e.target.value)}
      />

      {preview?.warnings && preview.warnings.length > 0 && (
        <Alert icon={<IconAlertTriangle />} title="Conversion Warnings" color="yellow">
          <Stack gap="xs">
            {preview.warnings.map((warning, i) => (
              <div key={i}>
                <strong>{warning.type}:</strong> {warning.message}
              </div>
            ))}
          </Stack>
        </Alert>
      )}

      <details>
        <summary style={{ cursor: 'pointer' }}>
          Preview Markdown (click to expand)
        </summary>
        {isLoadingPreview ? (
          <Loader size="sm" />
        ) : (
          <Code block mt="xs">
            {preview?.markdown || 'No preview available'}
          </Code>
        )}
      </details>

      <Group justify="flex-end" mt="md">
        <Button variant="light" onClick={() => modals.closeAll()}>
          Cancel
        </Button>
        <Button
          leftSection={<IconBrandGithub size={16} />}
          onClick={handleSubmit}
          loading={createPRMutation.isPending}
        >
          Create Pull Request
        </Button>
      </Group>
    </Stack>
  );
}
```

### 4. 衝突解決 Modal

```tsx
// apps/client/src/features/github/components/ConflictResolutionModal.tsx

import { useState } from 'react';
import { Stack, Alert, Tabs, Button, Group, Text } from '@mantine/core';
import { IconAlertTriangle, IconArrowRight, IconBrandGithub } from '@tabler/icons-react';
import { useQuery, useMutation } from '@tanstack/react-query';
import { DiffEditor } from '@monaco-editor/react';

interface ConflictResolutionModalProps {
  pageId: string;
}

export function ConflictResolutionModal({ pageId }: ConflictResolutionModalProps) {
  const [resolution, setResolution] = useState<'local' | 'remote' | null>(null);

  const { data: conflictData } = useQuery({
    queryKey: ['github-conflict', pageId],
    queryFn: () => githubApi.checkConflict(pageId),
  });

  if (!conflictData?.hasConflict) {
    return <Alert color="green">No conflict detected</Alert>;
  }

  return (
    <Stack>
      <Alert
        icon={<IconAlertTriangle />}
        title="Conflict Detected"
        color="orange"
      >
        GitHub has new changes that conflict with your local edits.
        Please choose how to resolve:
      </Alert>

      <Tabs defaultValue="diff">
        <Tabs.List>
          <Tabs.Tab value="diff">Side-by-Side Diff</Tabs.Tab>
          <Tabs.Tab value="local">Your Version</Tabs.Tab>
          <Tabs.Tab value="remote">GitHub Version</Tabs.Tab>
        </Tabs.List>

        <Tabs.Panel value="diff" pt="md">
          <DiffEditor
            height="400px"
            original={conflictData.conflictDetails.remoteContent}
            modified={conflictData.conflictDetails.localContent}
            language="markdown"
            options={{
              readOnly: true,
              renderSideBySide: true,
            }}
          />
        </Tabs.Panel>

        <Tabs.Panel value="local" pt="md">
          <Code block h={400} style={{ overflow: 'auto' }}>
            {conflictData.conflictDetails.localContent}
          </Code>
        </Tabs.Panel>

        <Tabs.Panel value="remote" pt="md">
          <Code block h={400} style={{ overflow: 'auto' }}>
            {conflictData.conflictDetails.remoteContent}
          </Code>
        </Tabs.Panel>
      </Tabs>

      <Stack gap="xs">
        <Text size="sm" fw={500}>Choose resolution strategy:</Text>

        <Button
          variant={resolution === 'local' ? 'filled' : 'light'}
          onClick={() => setResolution('local')}
          leftSection={<IconArrowRight size={16} />}
        >
          Use My Version (Overwrite GitHub)
        </Button>

        <Button
          variant={resolution === 'remote' ? 'filled' : 'light'}
          onClick={() => setResolution('remote')}
          leftSection={<IconBrandGithub size={16} />}
        >
          Use GitHub Version (Discard My Changes)
        </Button>
      </Stack>

      <Alert color="red" icon={<IconAlertTriangle />}>
        <strong>Warning:</strong> Manual merge is not supported yet.
        You must choose one version completely.
      </Alert>

      <Group justify="flex-end" mt="md">
        <Button variant="light" onClick={() => modals.closeAll()}>
          Cancel
        </Button>
        <Button
          color="orange"
          disabled={!resolution}
          onClick={() => handleResolve(resolution!)}
        >
          Resolve Conflict
        </Button>
      </Group>
    </Stack>
  );
}
```

---

## 錯誤處理

### 1. 編輯中被覆蓋（最嚴重）

**檢測方式：**
- Webhook 處理時檢查 `github_edit_sessions`
- 如果 `isActive = true`，跳過同步

**恢復機制：**
```typescript
// 如果誤覆蓋，使用快照恢復
async function recoverFromOverwrite(pageId: string) {
  const session = await db
    .selectFrom('githubEditSessions')
    .select(['snapshotContent'])
    .where('pageId', '=', pageId)
    .orderBy('startedAt', 'desc')
    .limit(1)
    .executeTakeFirst();

  if (session?.snapshotContent) {
    await pageRepo.updatePage({
      content: session.snapshotContent,
      lastUpdatedById: SYSTEM_USER_ID,
    }, pageId);
  }
}
```

### 2. 推送失敗（部分文件成功）

**處理策略：**
- 使用 transaction：要麼全部成功，要麼全部回滾
- 如果某個文件失敗，刪除整個分支重新來過

```typescript
async function rollbackFailedPR(branchName: string, source: GithubSource, token: string) {
  try {
    // 刪除創建的分支
    await githubApi.deleteBranch(source.owner, source.repo, branchName, token);
  } catch (error) {
    logger.error('Failed to rollback branch', error);
  }

  // 標記 PR batch 為失敗
  await db
    .updateTable('githubPrBatches')
    .set({
      prStatus: 'failed',
      errorMessage: 'Partial push failed, branch rolled back'
    })
    .where('branchName', '=', branchName)
    .execute();
}
```

### 3. Rate Limit

**檢測與重試：**
```typescript
async function githubApiCallWithRetry(apiCall: () => Promise<any>, maxRetries = 3) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await apiCall();
    } catch (error) {
      if (error.status === 429) {
        // Rate limit
        const resetTime = error.headers['x-ratelimit-reset'];
        const waitMs = (parseInt(resetTime) * 1000) - Date.now();

        if (waitMs > 0 && waitMs < 60000) { // 最多等 1 分鐘
          await sleep(waitMs);
          continue;
        }
      }
      throw error;
    }
  }
}
```

### 4. 網絡中斷

**Background Job 機制：**
```typescript
// 使用 BullMQ 處理非同步推送
import { Queue, Worker } from 'bullmq';

const prQueue = new Queue('github-pr-creation');

// 添加任務到隊列
async function queuePRCreation(data: CreatePRRequest) {
  await prQueue.add('create-pr', data, {
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 5000,
    },
  });
}

// Worker 處理任務
const worker = new Worker('github-pr-creation', async (job) => {
  return await createPullRequest(job.data);
}, {
  connection: redis,
  limiter: {
    max: 10,        // 最多 10 個並發任務
    duration: 60000 // 每分鐘
  }
});
```

---

## 實現階段

### Phase 1：基礎設施（1-2 週）

**目標：** 建立編輯保護機制

- [ ] 資料庫 migration（4 個新表）
- [ ] `github_edit_sessions` CRUD
- [ ] `onPageEditStart/End` hooks
- [ ] 編輯活動追蹤（WebSocket heartbeat）
- [ ] 清理過期 session 的背景任務
- [ ] 前端：編輯狀態指示器

**測試：**
- 開啟頁面編輯 → session 被創建
- 關閉編輯器 → session 正確結束
- 30 分鐘無活動 → session 自動過期

---

### Phase 2：Webhook 保護（1 週）

**目標：** Webhook 不覆蓋編輯中的內容

- [ ] 修改 `handlePush` 檢查 active sessions
- [ ] 跳過編輯中的文件
- [ ] 記錄延遲同步事件
- [ ] 通知編輯者有遠端變更

**測試：**
- 用戶正在編輯 → GitHub push → 不覆蓋本地內容
- 編輯結束後 → 收到衝突提示

---

### Phase 3：變更追蹤（1-2 週）

**目標：** 追蹤哪些頁面有未推送的修改

- [ ] `github_pending_changes` CRUD
- [ ] `checkPageModified` 實現
- [ ] `createPendingChange` 實現
- [ ] `checkRemoteChanges` 實現（衝突檢測）
- [ ] API: 獲取待推送變更列表

**測試：**
- 編輯頁面 → 產生 pending change
- 遠端有新 commit → 標記為衝突

---

### Phase 4：TipTap → Markdown（2-3 週）

**目標：** 實現完整的格式轉換器

- [ ] `TipTapMarkdownSerializer` 基礎框架
- [ ] 支援所有標準 Markdown 節點
- [ ] 支援 Docmost 自定義節點（callout, details 等）
- [ ] 處理內部連結（轉相對路徑）
- [ ] 處理附件（下載 + 上傳到 GitHub）
- [ ] API: 預覽 Markdown

**測試：**
- 各種格式的頁面 → 轉換為正確的 Markdown
- 內部連結 → 轉換為相對路徑
- 圖片 → 上傳到 GitHub assets 目錄

---

### Phase 5：PR 創建（2-3 週）

**目標：** 完整的 PR 創建流程

- [ ] `GithubPRService` 實現
- [ ] 創建分支
- [ ] 批次上傳文件
- [ ] 創建 Pull Request
- [ ] 記錄 PR batch
- [ ] 清理 pending changes
- [ ] 錯誤處理與回滾
- [ ] API: 創建 PR、PR 歷史

**測試：**
- 單文件推送 → 成功創建 PR
- 多文件推送 → 所有文件在一個 PR
- 推送失敗 → 正確回滾

---

### Phase 6：前端 UI（2 週）

**目標：** 完整的用戶界面

- [ ] `GithubEditStatus` 組件
- [ ] `GithubPushButton` 整合到 PageHeader
- [ ] `CreatePRModal` 實現
- [ ] `ConflictResolutionModal` 實現
- [ ] Markdown 預覽
- [ ] PR 歷史頁面

**測試：**
- 編輯狀態正確顯示
- 推送按鈕在正確時機啟用
- PR 創建流程順暢

---

### Phase 7：衝突解決（1-2 週）

**目標：** 讓用戶能處理衝突

- [ ] 衝突檢測 API
- [ ] Diff 顯示（Monaco Editor）
- [ ] 選擇本地/遠端版本
- [ ] 衝突解決後重新推送

**測試：**
- 檢測到衝突 → 正確顯示 diff
- 選擇解決方案 → 成功推送

---

### Phase 8：測試與優化（1-2 週）

**目標：** 穩定性與效能

- [ ] 單元測試（核心邏輯）
- [ ] 整合測試（API 流程）
- [ ] E2E 測試（完整用戶流程）
- [ ] 壓力測試（大型文件、批次推送）
- [ ] 錯誤處理測試
- [ ] 文檔撰寫

---

## 總工時估算

| Phase | 時間 | 累計 |
|-------|------|------|
| Phase 1 | 1-2 週 | 2 週 |
| Phase 2 | 1 週 | 3 週 |
| Phase 3 | 1-2 週 | 5 週 |
| Phase 4 | 2-3 週 | 8 週 |
| Phase 5 | 2-3 週 | 11 週 |
| Phase 6 | 2 週 | 13 週 |
| Phase 7 | 1-2 週 | 15 週 |
| Phase 8 | 1-2 週 | 17 週 |

**總計：約 3-4 個月（全職開發）**

---

## 風險與注意事項

### 🔴 高風險

1. **資料丟失風險**
   - 編輯保護機制必須 100% 可靠
   - 建議：初期加入大量日誌和監控

2. **格式轉換損失**
   - TipTap → Markdown 可能有格式損失
   - 建議：明確告知用戶不支援的功能

3. **併發衝突**
   - 多人同時推送到同一個 source
   - 建議：使用資料庫 transaction + 樂觀鎖

### 🟡 中風險

4. **GitHub API Rate Limit**
   - 每小時 5000 次請求（authenticated）
   - 建議：實現 rate limit 檢測和重試機制

5. **大型附件**
   - GitHub 單文件最大 100MB
   - 建議：檢查文件大小，超過限制時警告用戶

6. **分支管理**
   - 分支數量增長問題
   - 建議：定期清理已合併的分支

### 🟢 低風險

7. **效能問題**
   - 大量文件推送可能較慢
   - 建議：使用背景任務隊列

---

## 成功指標

### 功能完整性
- [ ] 100% 防止編輯中資料被覆蓋
- [ ] 95%+ 的 TipTap 功能可轉換為 Markdown
- [ ] 衝突檢測準確率 100%
- [ ] PR 創建成功率 > 98%

### 效能
- [ ] 編輯保護檢查 < 100ms
- [ ] Markdown 轉換 < 2s（10KB 文件）
- [ ] PR 創建 < 30s（5 個文件）

### 用戶體驗
- [ ] 從編輯到 PR 創建 < 5 步驟
- [ ] 衝突解決流程清晰易懂
- [ ] 所有錯誤都有明確提示

---

## 附錄

### A. GitHub API 參考

#### 創建分支
```
POST /repos/{owner}/{repo}/git/refs
{
  "ref": "refs/heads/branch-name",
  "sha": "base-commit-sha"
}
```

#### 更新文件
```
PUT /repos/{owner}/{repo}/contents/{path}
{
  "message": "commit message",
  "content": "base64-encoded-content",
  "sha": "current-file-sha",
  "branch": "branch-name"
}
```

#### 創建 PR
```
POST /repos/{owner}/{repo}/pulls
{
  "title": "PR title",
  "body": "PR description",
  "head": "branch-name",
  "base": "main"
}
```

### B. 數據庫索引建議

```sql
-- 快速查找活動的編輯 session
CREATE INDEX idx_github_edit_sessions_page_active
ON github_edit_sessions(page_id)
WHERE is_active = true;

-- 快速查找 pending changes
CREATE INDEX idx_github_pending_changes_source_conflict
ON github_pending_changes(source_id, has_conflict);

-- 快速清理過期 session
CREATE INDEX idx_github_edit_sessions_cleanup
ON github_edit_sessions(last_activity_at)
WHERE is_active = true;
```

### C. 環境變數

需要新增的權限：

```bash
# GitHub App 需要的權限
GITHUB_APP_PERMISSIONS=contents:write,pull_requests:write
```

---

## 已知限制與 Phase 2 計劃

### 🟡 MVP 版本的已知限制

以下功能在 MVP (Phase 1) 中**未實現**，但不影響核心功能使用。這些將在 Phase 2 進行優化。

#### 1. **附件 SHA 追蹤與更新優化** ⏸️

**現況：**
- 每次推送 PR 時，所有附件都會重新上傳到 GitHub
- 如果附件已存在但沒有提供 `sha`，GitHub API 會返回 409 錯誤
- 當前處理方式：跳過失敗的附件上傳，繼續處理其他文件

**影響：**
- 浪費 API quota（重複上傳相同附件）
- 附件上傳失敗時，PR 中的圖片連結可能失效

**Phase 2 改進：**
- 在 `github_files` 表中追蹤附件的 `sha`（`contentType='asset'`）
- 上傳前檢查附件內容是否變更（比對 hash）
- 只上傳變更的附件，更新時提供正確的 `sha`

**暫時解決方案：**
- 第一次創建 PR 時附件會成功上傳
- 後續 PR 如果包含相同附件，會跳過失敗的上傳
- 用戶可以手動刪除舊附件後重新推送

---

#### 2. **推送前 SHA 驗證（防止 Race Condition）** ⏸️

**現況：**
- 衝突檢測和實際推送之間可能有時間差
- 如果在這段時間內遠端文件被修改，推送會失敗（GitHub API 返回 409）

**影響：**
- 推送 PR 可能會中途失敗
- 錯誤訊息不夠友善（需要用戶手動刷新並重新檢測衝突）

**Phase 2 改進：**
```typescript
// 在每個文件推送前再次驗證 SHA
for (const file of filesToPush) {
  const currentRemote = await githubApi.getContent(...);
  if (currentRemote.sha !== file.sha) {
    throw new ConflictError('File changed during PR creation');
  }
  await githubApi.createOrUpdateFile(...);
}
```

**暫時解決方案：**
- 推送失敗時，提示用戶重新檢測衝突
- 大部分情況下（非高併發編輯）不會遇到此問題

---

#### 3. **Markdown Serializer 格式支援不完整** ⏸️

**現況：**
- 基本的 Markdown 格式已支援（標題、段落、列表、表格、圖片、連結等）
- 以下格式轉換可能不完美：
  - ✅ 任務列表（`- [ ]` 和 `- [x]`）- 未實現
  - ✅ 嵌套列表縮排 - 可能格式不正確
  - ✅ 複雜表格（合併儲存格、多行內容）- 不支援
  - ✅ 程式碼區塊多行內容 - 可能遺失換行符
  - ✅ 特殊字符轉義（`[`, `]`, `(`, `)` 等）- 未處理

**影響：**
- 部分格式在 GitHub 顯示不正確
- 轉換後可能有格式損失

**Phase 2 改進：**
- 逐步完善 `TipTapMarkdownSerializer`
- 增強特殊字符處理
- 支援 GitHub Flavored Markdown 擴展語法

**暫時解決方案：**
- 在創建 PR 前使用**預覽功能**檢查轉換結果
- API 會返回 `warnings` 提示不支援的功能
- 用戶可以在 GitHub 上手動修正格式

---

#### 4. **衝突解決 UI 的 Base64 解碼** ⏸️

**現況：**
- 衝突檢測 API 返回的 `remoteContent` 是 Base64 編碼
- 前端 `ConflictResolutionModal` 可能直接顯示 Base64 字串

**影響：**
- 用戶無法閱讀遠端內容

**Phase 2 改進：**
```typescript
// 在前端解碼
const remoteMarkdown = atob(conflictData.remoteContent);

// 或在後端 API 直接返回解碼後的內容
return {
  remoteContent: Buffer.from(base64, 'base64').toString('utf-8')
};
```

**暫時解決方案：**
- 暫時只顯示 "Remote has changes"，不顯示具體內容
- 提示用戶到 GitHub 上查看遠端文件

---

#### 5. **GitHub 附件大小檢查** ⏸️

**現況：**
- 未檢查附件大小，直接嘗試上傳
- GitHub 單文件限制 100MB，超過會上傳失敗

**影響：**
- 大型附件上傳失敗，PR 創建失敗

**Phase 2 改進：**
```typescript
if (fileBuffer.length > 100 * 1024 * 1024) {
  warnings.push({
    type: 'file_too_large',
    fileName,
    size: fileBuffer.length
  });
  continue; // 跳過上傳
}
```

**暫時解決方案：**
- 推送失敗時，錯誤訊息會提示哪個文件過大
- 用戶需要壓縮或移除大型附件

---

#### 6. **Queue 系統整合** ⏸️

**現況：**
- PR 創建同步執行（在 HTTP 請求內完成）
- 大量文件可能導致請求超時

**影響：**
- 超過 30 秒的 PR 創建會超時失敗
- 無法處理超大型批次推送（>100 個文件）

**Phase 2 改進：**
- 使用 `@nestjs/bullmq` 實現背景任務
- PR 創建立即返回 `jobId`，用戶可以追蹤進度
- 支援重試和錯誤恢復

**暫時解決方案：**
- 限制每次 PR 最多包含 50 個文件
- 大型 repo 分批創建多個 PR

---

#### 7. **分支自動清理** ⏸️

**現況：**
- 創建的 `docmost-sync/*` 分支不會自動刪除
- 已合併的 PR 對應的分支會保留在 GitHub

**影響：**
- 分支數量累積，repo 變得雜亂

**Phase 2 改進：**
- 定時任務（每日）自動清理已合併 >7 天的分支
- PR 合併時觸發 webhook，自動刪除分支

**暫時解決方案：**
- 在 GitHub repo settings 啟用 "Automatically delete head branches"
- 或手動定期清理舊分支

---

### 📋 Phase 2 優先級排序

| 優先級 | 功能 | 預計工時 | 理由 |
|-------|------|---------|------|
| **P1** | 推送前 SHA 驗證 | 1-2 天 | 防止推送失敗，用戶體驗影響大 |
| **P2** | 附件 SHA 追蹤 | 2-3 天 | 減少 API quota 浪費，避免上傳失敗 |
| **P3** | Markdown serializer 增強 | 3-5 天 | 提升格式轉換品質 |
| **P4** | Queue 系統整合 | 2-3 天 | 支援大型批次推送 |
| **P5** | 衝突 UI 改進 | 1 天 | Base64 解碼 + 更好的 diff 顯示 |
| **P6** | 分支自動清理 | 1 天 | 保持 repo 乾淨 |
| **P7** | 附件大小檢查 | 0.5 天 | 提前提示用戶 |

---

**文檔版本：** 1.1
**最後更新：** 2025-01-09
**作者：** Claude + Audi

# GitHub Integration Setup Guide

## 完整的 OAuth 安裝流程已實作！

使用者現在可以一鍵連接 GitHub App，就像其他服務（Stripe, Google 等）一樣。

---

## 設定步驟

### 1. 在 GitHub 建立 GitHub App

前往：https://github.com/settings/apps/new

#### 基本設定
- **GitHub App name**: 你的 App 名稱（例如：`docmost-integration`）
- **Homepage URL**: `https://yourdomain.com`
- **Callback URL**: `https://yourdomain.com/api/integrations/github/callback`
- **Webhook URL**: `https://yourdomain.com/api/integrations/github/webhook`
- **Webhook secret**: 生成一個隨機字串（使用 `openssl rand -hex 32`）

#### 權限設定（Repository permissions）
- **Contents**: Read-only
- **Metadata**: Read-only

#### 事件訂閱（Subscribe to events）
- ✅ Push
- ✅ Installation
- ✅ Installation repositories

### 2. 記錄 App 資訊

建立完成後，記錄以下資訊：

1. **App ID**: 在 App 設定頁面頂部
2. **App Slug**: URL 中的名稱（例如：`docmost-integration`）
3. **Client ID**: 在 App 設定頁面
4. **Private Key**: 點擊「Generate a private key」下載

### 3. 設定環境變數

在你的 `.env` 檔案中添加：

```bash
# GitHub App 設定
GITHUB_APP_ID=你的APP_ID
GITHUB_APP_SLUG=你的APP_SLUG_NAME  # 例如: docmost-integration
GITHUB_APP_CLIENT_ID=你的CLIENT_ID
GITHUB_APP_PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----
你的私鑰內容
-----END RSA PRIVATE KEY-----"
GITHUB_APP_WEBHOOK_SECRET=你的WEBHOOK_SECRET

# API 設定（預設值，可不改）
GITHUB_API_BASE=https://api.github.com
GITHUB_API_VERSION=2022-11-28
```

**重要**:
- `GITHUB_APP_PRIVATE_KEY` 需要保留換行符號，使用 `\n` 或引號包裹多行
- `GITHUB_APP_SLUG` 是 App 的 URL 名稱，不是 App Name

### 4. 重啟服務

```bash
pnpm run dev
```

---

## 使用流程

### 管理員設定

1. 登入 Docmost
2. 前往 **Settings → Integrations → GitHub**
3. 點擊「**Connect GitHub**」按鈕
4. 會自動跳轉到 GitHub 授權頁面
5. 選擇要安裝到哪個帳號/組織
6. 選擇要授權的 repositories（All 或 Selected）
7. 點擊「Install」
8. 自動跳回 Docmost，顯示成功訊息
9. 可以看到已連接的 installation

### 建立同步 Source

1. 在 **Add Source** 區塊：
   - 選擇 Installation
   - 選擇 Repository
   - 選擇 Branch/Ref
   - 設定 Root directory（可選）
   - 選擇目標 Space
   - 設定 Target path（可選）
2. 點擊「Create source」
3. 系統會自動開始完整同步

### 後續更新

- **自動同步**: 當你 push 到 GitHub 時，webhook 會自動更新對應的頁面
- **手動同步**: 點擊 Source 的「Rescan」按鈕
- **刷新 Installations**: 點擊「Refresh」按鈕（備用，通常不需要）

---

## 疑難排解

### 1. 「Connect GitHub」點擊後沒反應

檢查：
- `.env` 中的 `GITHUB_APP_SLUG` 是否正確
- Browser console 是否有錯誤訊息

### 2. Callback 後顯示錯誤

檢查：
- GitHub App 的 **Callback URL** 是否設定正確：`https://yourdomain.com/api/integrations/github/callback`
- `.env` 中的 `APP_URL` 是否正確

### 3. Webhook 沒有觸發

檢查：
- GitHub App 的 **Webhook URL** 是否設定正確
- **Webhook secret** 是否與 `.env` 中的 `GITHUB_APP_WEBHOOK_SECRET` 一致
- Server 是否可從外網訪問（GitHub 需要能發送 webhook）
- GitHub App Settings → Advanced → Recent Deliveries 查看 webhook 狀態

### 4. 同步失敗

檢查 server logs：
```bash
# 查看錯誤訊息
pnpm run dev
```

常見錯誤：
- `invalid_github_private_key_format`: 私鑰格式錯誤，確認換行符號正確
- `installation_not_found`: Installation ID 不存在或已被刪除
- `403`: 權限不足，檢查 GitHub App 的 repository permissions

---

## 安全建議

1. **私鑰保護**: 不要將 `.env` 檔案提交到 Git
2. **Webhook Secret**: 使用強隨機字串
3. **權限最小化**: 只給必要的 repository permissions
4. **定期檢查**: 在 GitHub Settings 檢查已安裝的 Apps

---

## 架構說明

### OAuth 流程

```
User clicks "Connect GitHub"
    ↓
GET /api/integrations/github/installations/auth-url
    ↓ (returns GitHub install URL with state)
Redirect to GitHub
    ↓
User authorizes & installs App
    ↓
GitHub redirects to callback
    ↓
GET /api/integrations/github/callback?installation_id=XXX&state=YYY
    ↓
Server validates state, links installation to workspace
    ↓
Redirect to frontend with success/error
    ↓
Frontend shows notification & refreshes list
```

### Webhook 自動同步

```
User pushes to GitHub
    ↓
GitHub sends webhook
    ↓
POST /api/integrations/github/webhook
    ↓
Verify signature
    ↓
Process push event (added/modified/removed/renamed)
    ↓
Update pages in Docmost
```

---

## 完成！

現在你的 GitHub 整合已經完全設定好了！使用者可以：
- ✅ 一鍵連接 GitHub
- ✅ 自動同步 markdown 內容
- ✅ Webhook 即時更新
- ✅ 多 repo 支援
- ✅ 圖片/附件自動處理

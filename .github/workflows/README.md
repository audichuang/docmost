# GitHub Actions Workflows

## Docker Build CI

自動 build 並 push Docker image 到 Docker Hub。

### 設定步驟

#### 1. 檢查 Workflow 變數 (可選修改)

`.github/workflows/docker-build.yml` 預設設定：

```yaml
env:
  BRANCH_NAME: dev          # 觸發的分支
  IMAGE_NAME: docmost       # Docker image 名稱 (可改成其他名稱)
  PLATFORMS: linux/amd64,linux/arm64  # 支援的平台
```

最終 image 會是：`你的帳號/docmost`

#### 2. 設定 GitHub Secrets

在 GitHub repo 中設定以下 secrets：

1. 前往 `Settings` → `Secrets and variables` → `Actions`
2. 點擊 `New repository secret`
3. 添加以下兩個 secrets：

| Name | Value | 說明 |
|------|-------|------|
| `DOCKERHUB_USERNAME` | 你的 Docker Hub 使用者名稱 | 例如: `audichuang` |
| `DOCKERHUB_TOKEN` | Docker Hub Access Token | 見下方取得方式 |

**範例**：
- 如果 `DOCKERHUB_USERNAME` = `audichuang`
- 那麼 image 完整路徑 = `audichuang/docmost`

#### 3. 取得 Docker Hub Access Token

1. 登入 [Docker Hub](https://hub.docker.com/)
2. 點擊右上角頭像 → `Account Settings`
3. 左側選單選擇 `Security`
4. 點擊 `New Access Token`
5. 輸入 Token 描述 (例如: `GitHub Actions`)
6. 權限選擇 `Read, Write, Delete`
7. 點擊 `Generate`
8. **立即複製 Token**（只會顯示一次）
9. 貼到 GitHub Secrets 的 `DOCKERHUB_TOKEN`

### 觸發方式

- **自動觸發**: 當 push 到 `dev` 分支時
- **手動觸發**: 前往 `Actions` tab → 選擇 workflow → `Run workflow`

### Image Tags

每次 build 會產生三個 tags：

- `latest` - 最新版本
- `dev` - dev 分支最新版本
- `dev-{git-sha}` - 特定 commit 版本

### 使用 Docker Image

```bash
# Pull 最新版本 (替換成你的使用者名稱)
docker pull 你的帳號/docmost:latest

# Pull dev 版本
docker pull 你的帳號/docmost:dev

# Pull 特定 commit 版本
docker pull 你的帳號/docmost:dev-abc1234
```

### 修改觸發分支

如果要改成 `main` 分支觸發，修改兩個地方：

1. 第 5 行的 `BRANCH_NAME: main`
2. 第 13 行的 `- main`

### 疑難排解

- **Build 失敗**: 檢查 Actions tab 的錯誤訊息
- **Push 失敗**: 確認 Docker Hub credentials 是否正確
- **Secrets 找不到**: 確認 secret 名稱是否完全一致（大小寫敏感）

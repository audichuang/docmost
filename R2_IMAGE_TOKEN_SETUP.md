# Cloudflare R2 圖片 Token 保護設置指南

## 功能概述

此功能自動為 Cloudflare R2 託管的圖片 URL 添加 HMAC-SHA256 簽名的 token，確保圖片只能通過驗證的請求訪問。

### 工作原理

1. **後端攔截**：當從資料庫讀取頁面內容時，後端自動檢測 R2 圖片 URL
2. **Token 生成**：使用 HMAC-SHA256 生成帶時間戳的 token
3. **URL 轉換**：將 `?token=xxx` 參數附加到所有 R2 圖片 URL
4. **Token 緩存**：Token 緩存 5 分鐘，過期前 30 秒自動刷新

### 轉換示例

**轉換前：**
```
https://docmostimage.audichuang.app/docmost/abc123.png
```

**轉換後：**
```
https://docmostimage.audichuang.app/docmost/abc123.png?token=1728649234567.a1b2c3d4...
```

---

## 配置步驟

### 1. 設置環境變數

在 `.env` 文件中添加以下配置：

```bash
# Cloudflare R2 Image Token Protection
R2_IMAGE_DOMAIN=docmostimage.audichuang.app
R2_TOKEN_SECRET=your-jwt-secret-here
R2_TOKEN_VALIDITY_SECONDS=300
```

#### 配置說明

| 環境變數 | 說明 | 必需 | 預設值 |
|---------|------|------|--------|
| `R2_IMAGE_DOMAIN` | R2 圖片域名（不含協議） | ✅ | - |
| `R2_TOKEN_SECRET` | Token 簽名密鑰 | ⚠️ | 使用 `APP_SECRET` |
| `R2_TOKEN_VALIDITY_SECONDS` | Token 有效期（秒） | ❌ | 300 (5分鐘) |

**注意：**
- `R2_TOKEN_SECRET` 如果不設置，會自動使用 `APP_SECRET`（建議使用相同密鑰）
- `R2_IMAGE_DOMAIN` 只需要域名，不要包含 `https://`

---

### 2. Cloudflare Worker 配置

確保你的 Cloudflare Worker 使用相同的密鑰驗證 token。

**Worker 環境變數：**
```javascript
// wrangler.toml 或 Cloudflare Dashboard
JWT_SECRET = "your-jwt-secret-here"  // 與 R2_TOKEN_SECRET 相同
```

**Worker token 驗證邏輯：**
```javascript
function verifyToken(token, secret) {
  const [timestamp, signature] = token.split('.');
  const expectedSignature = crypto
    .createHmac('sha256', secret)
    .update(timestamp)
    .digest('hex');

  // 檢查簽名
  if (signature !== expectedSignature) {
    return false;
  }

  // 檢查過期（5分鐘 + 30秒緩衝）
  const expirationTime = parseInt(timestamp) + 330000;
  return Date.now() < expirationTime;
}
```

---

## 驗證配置

### 測試步驟

1. **啟動應用**
```bash
cd /Users/audi/GoogleDrive/Github/docmost
pnpm run dev
```

2. **創建測試頁面**
   - 在 Docmost 中創建一個新頁面
   - 上傳一張圖片到 R2（確保圖片 URL 使用 `docmostimage.audichuang.app`）

3. **檢查圖片 URL**
   - 打開瀏覽器開發者工具（F12）
   - 切換到 Network 標籤
   - 重新加載頁面
   - 檢查圖片請求的 URL 是否包含 `?token=` 參數

4. **驗證 Token 有效性**
```bash
# 從瀏覽器複製帶 token 的圖片 URL
curl -I "https://docmostimage.audichuang.app/docmost/YOUR_IMAGE.png?token=GENERATED_TOKEN"

# 應該返回 200 OK
HTTP/2 200
content-type: image/png
...

# 移除 token 測試（應該返回 401）
curl -I "https://docmostimage.audichuang.app/docmost/YOUR_IMAGE.png"

# 應該返回 401 Unauthorized
HTTP/2 401
...
```

---

## 技術實現細節

### 已修改的文件

#### 新建文件（3個）
1. `apps/server/src/integrations/r2-token/r2-token.service.ts` - Token 生成服務
2. `apps/server/src/integrations/r2-token/content-transformer.service.ts` - URL 轉換服務
3. `apps/server/src/integrations/r2-token/r2-token.module.ts` - 模組定義

#### 修改文件（7個）
1. `.env.example` - 添加環境變數範例
2. `apps/server/src/integrations/environment/environment.service.ts` - 添加 getter 方法
3. `apps/server/src/core/page/page.module.ts` - 導入 R2TokenModule
4. `apps/server/src/core/page/page.controller.ts` - 添加內容轉換邏輯
5. `apps/server/src/core/share/share.module.ts` - 導入 R2TokenModule
6. `apps/server/src/core/share/share.service.ts` - 添加內容轉換邏輯

### 處理的端點

✅ **已處理的 API 端點：**
- `POST /api/pages/info` - 獲取頁面內容
- `POST /api/pages/history/info` - 獲取頁面歷史版本
- `POST /api/shares/page-info` - 獲取公開分享頁面

### Token 格式

```
timestamp.signature
├─ timestamp: Unix 毫秒時間戳
└─ signature: HMAC-SHA256(timestamp, secret)
```

**示例：**
```
1728649234567.a1b2c3d4e5f6789012345678901234567890abcdef1234567890abcdef123456
```

---

## 性能優化

### Token 緩存策略

- **緩存時間**：5 分鐘
- **刷新策略**：過期前 30 秒自動刷新
- **緩存位置**：內存（單實例）

### URL 轉換優化

- **快速檢測**：先檢查內容是否包含 R2 域名，避免不必要的正則匹配
- **批量替換**：使用正則表達式一次性替換所有 URL
- **惰性處理**：只在包含 R2 URL 的內容上執行轉換

---

## 故障排除

### 問題 1：圖片顯示 401 Unauthorized

**可能原因：**
- R2_IMAGE_DOMAIN 未配置
- R2_TOKEN_SECRET 與 Worker 不匹配
- Token 已過期

**解決方法：**
1. 檢查 `.env` 配置是否正確
2. 重啟應用重新加載環境變數
3. 檢查 Cloudflare Worker 的密鑰配置

### 問題 2：圖片 URL 沒有 token 參數

**可能原因：**
- R2_IMAGE_DOMAIN 配置錯誤
- 內容中的圖片 URL 不匹配配置的域名

**解決方法：**
1. 確認圖片 URL 是否包含配置的域名
2. 檢查瀏覽器 console 是否有錯誤訊息
3. 查看後端日誌確認轉換是否執行

### 問題 3：TypeScript 編譯錯誤

**解決方法：**
```bash
cd /Users/audi/GoogleDrive/Github/docmost/apps/server
pnpm exec tsc --noEmit
```

如果出現類型錯誤，檢查 `page.content` 和 `history.content` 的類型處理是否正確。

---

## 安全考量

### Token 安全

1. **密鑰管理**
   - 使用強密鑰（建議 32+ 字元）
   - 與 JWT_SECRET 保持一致（避免密鑰洩漏）
   - 不要在日誌或錯誤訊息中暴露密鑰

2. **Token 有效期**
   - 預設 5 分鐘，可根據需求調整
   - 過短：影響緩存效果
   - 過長：增加安全風險

3. **HTTPS 要求**
   - 確保所有請求使用 HTTPS
   - Token 在傳輸過程中加密

### 訪問控制

- Token 只驗證請求是否來自可信客戶端
- 不替代頁面級別的權限控制
- 公開分享頁面仍需遵守分享設置

---

## 維護和監控

### 日誌監控

後端會記錄以下調試訊息：

```typescript
// Token 生成
'Generating new R2 token'
'Using cached R2 token'

// 內容轉換
'Transformed content with R2 image tokens'
```

### 性能監控

建議監控以下指標：
- Token 緩存命中率
- 內容轉換平均耗時
- R2 圖片請求成功率

---

## 未來改進

### 可選優化

1. **Redis 緩存**
   - 跨實例共享 token
   - 提高緩存命中率

2. **內容緩存**
   - 緩存已轉換的頁面內容
   - 減少重複轉換開銷

3. **Token 輪換**
   - 定期更換密鑰
   - 支援多密鑰驗證（過渡期）

4. **監控儀表板**
   - Token 使用統計
   - 失敗請求分析

---

## 聯絡資訊

如有問題或建議，請聯繫：
- 開發者：Claude Code
- 專案：Docmost R2 Image Token Protection
- 日期：2025-10-11

---

**配置完成！** 🎉

現在你的 R2 圖片已經受到 token 保護，只有經過驗證的請求才能訪問。

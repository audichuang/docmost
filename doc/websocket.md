# WebSocket 協作與 R2 Token 防護總覽

這份筆記說明 Docmost 在頁面編輯時的整體協作流程，特別聚焦於 WebSocket、Y.Doc 與 R2 圖片 Token 的運作方式，方便日後除錯與擴充。

---

## 1. 客戶端生命週期

- **初始資料來源**  
  頁面路由先透過 REST API 取得 `page.content`（TipTap JSON）。`page.controller.ts` 在回傳前會呼叫 `ContentTransformerService`，對 Cloudflare R2 圖片網址補上 `?token=...`，確保首次渲染就能觀看受保護的圖片。

- **協作編輯初始化**  
  `apps/client/src/features/editor/page-editor.tsx` 會在 render 階段同步建立新的 `Y.Doc`（`useMemo(() => new Y.Doc(), [pageId])`）。接著依序啟動：
  1. `useCollabToken()` 透過 `/auth/collab-token` 取得 Hocuspocus 用的 JWT。
  2. `IndexeddbPersistence`（若 `isLocked` 為 `false`）以 `page.<pageId>` 為 key，在本機 IndexedDB 快取文件狀態，離線時也能閱讀。
  3. `HocuspocusProvider` 指向 `/collab`，攜帶協作 token 建立 WebSocket 連線，並掛上 `synced`、`status` 事件更新 UI 狀態。

- **UI 狀態切換**  
  `hasConnectedOnceRef` 控制首次協作成功後就常駐 TipTap Editor；若 10 秒內仍未連線成功，會顯示錯誤橫幅並降級回唯讀的 `EditorProvider`。此設計避免舊的兩段式渲染造成圖片下載兩次，又能在網路受限時保留可閱讀的內容。

- **重新連線與 idle**  
  `useIdle` 與 `document.visibility` 事件偵測使用者離開頁面時主動斷線，回到頁面或恢復網路後再重新呼叫 `remote.connect()`，同時保有既有內容不閃爍。

---

## 2. 伺服器端協作流程

- **WebSocket 入口**  
  `CollaborationModule` 於 `/collab` 建立 Hocuspocus server，載入三個自訂 extension：
  1. `AuthenticationExtension`：驗證 `/auth/collab-token` 簽發的 JWT，檢查使用者是否擁有讀寫權；若僅有 `SpaceRole.READER` 就將連線設為唯讀。
  2. `PersistenceExtension`：處理文件載入與儲存邏輯。
  3. `LoggerExtension`：記錄連線狀態與診斷訊息。

- **載入文件 (`onLoadDocument`)**  
  1. 透過 `PageRepo.findById` 取得 `page.content`（JSON）與 `page.ydoc`（Yjs 二進位狀態）。
  2. 若資料庫已存在 `page.ydoc`，就先還原 `Y.Doc`，再利用 `TiptapTransformer.fromYdoc` 轉成 JSON，呼叫 `ContentTransformerService` 添加 Token，最後再轉回新的 `Y.Doc` 回傳。  
     → 這一步是近期的修補：若跳過轉換，圖片網址會缺少 `token`。
  3. 若 `page.ydoc` 不存在，則對 `page.content` 套用同樣的 Token 轉換後，使用 `TiptapTransformer.toYdoc` 產生 `Y.Doc`。
  4. 如仍無內容，回傳全新的 `Y.Doc` 供編輯器初始化。

- **儲存文件 (`onStoreDocument`)**  
  1. 將目前的 `Y.Doc` 轉回 TipTap JSON 與 `ydocState`（`Y.encodeStateAsUpdate`）。  
  2. 若頁面標記為 `isLocked`（GitHub 管理的唯讀頁），直接跳過保存。  
  3. 與資料庫現有內容比對，無更新就結束；否則寫回 `page.content`、`page.ydoc`、`textContent` 與最後編輯者資訊，並在 queue 裡派送引用/反向連結工作。

---

## 3. R2 圖片 Token 機制

- **ContentTransformerService**  
  1. 透過 `EnvironmentService` 取得 R2 網域與有效時間設定。  
  2. 呼叫 `R2TokenService` 取得（或快取）Cloudflare Worker 簽發的 token。  
  3. 對內容中的 `https://<R2_DOMAIN>/...` 進行 regex 取代，先移除舊的 `token=` 參數，再以 `?token=<newToken>` 或 `&token=<newToken>` 補上。  
  4. 日誌僅會記錄 token 前十碼與長度，避免洩漏。

- **R2TokenService**  
  - 每 5 分鐘重新取一次 token（可由 `R2_TOKEN_VALIDITY_SECONDS` 調整）。  
  - 從 `https://<R2_DOMAIN>/api/generate-token?secret=` 取得簽名字串，並於伺服器端快取，避免同一個頁面載入時重複打 API。

- **應用路徑**  
  1. REST 回傳的 `page.content`。  
  2. WebSocket 初次載入 `page.content`。  
  3. WebSocket 從資料庫還原 `page.ydoc`。  
  → 任一流程都會先呼叫 transformer，確保圖片網址附帶最新 token。

---

## 4. Y.Doc、`page.content` 與資料一致性

- **資料格式**
  - `page.content`：TipTap JSON（針對 REST/SSR 等需求）。  
  - `page.ydoc`：以 `Y.encodeStateAsUpdate` 存放的二進位 CRDT 狀態，方便快速還原協作現場。

- **為什麼要兩份資料？**  
  - TipTap JSON 方便 REST API、歷史版本、匯出等功能。  
  - Y.Doc 讓協作編輯器在加載時可以直接同步，大幅降低建立會話的時間。

- **常見陷阱**  
  - 只對 `page.content` 做 URL 轉換會導致從 `page.ydoc` 還原的內容缺少 token。  
  - 儲存時若不移除 URL 上舊 token，下一輪載入時 transformer 會先移除舊值再寫入新值，確保資料庫不會堆疊多個 `token=`。

---

## 5. 錯誤處理與偵錯建議

- **WebSocket 連線不上**：10 秒後編輯器會顯示「⚠️ 無法連接協作服務，以唯讀模式顯示內容」，可檢查瀏覽器為何阻擋 `/collab`。  
- **圖片缺少 Token**：檢查伺服器日誌是否出現 `[R2 Transform] Content contains R2 URLs: false` 或 `[Collab] Failed to transform R2 tokens...`，以及 `R2_IMAGE_DOMAIN` 設定是否正確。  
- **GitHub 鎖定頁面**：`PersistenceExtension` 會偵測 `isLocked`，停止寫入並於前端顯示唯讀橫幅。若需解除，必須調整 GitHub sync 的設定。  
- **Redis 整合**：若環境未設定 Redis，`EnvironmentService.isCollabDisableRedis()` 會避免載入 `@hocuspocus/extension-redis`，協作仍可運作但不會做跨實例同步。

---

## 6. 測試流程清單

1. **正常載入**：啟動 `pnpm run dev`，開啟任一頁面，確認 skeleton → 協作編輯器 → 圖片只請求一次且 URL 有 token。  
2. **離線降級**：暫時關掉 `/collab` 服務或網路，等待 10 秒，應顯示錯誤橫幅與唯讀畫面。  
3. **GitHub 鎖定頁面**：開啟 `isLocked=true` 的頁面，觀察 UI 顯示唯讀並且 WebSocket 仍能載入內容但不寫入。  
4. **Token 更新**：等待 R2 token 逾時後重新整理頁面，圖片仍能取得新的 token，伺服器日誌會記錄新的快取。  
5. **跨頁切換**：快速切換不同頁面，確保 `hasConnectedOnceRef` 與新的 `Y.Doc` 正確重置，不會看見前一頁的內容殘留。

---

## 7. 心智模型速記

```
REST 讀取 → (ContentTransformer 加 token) → 初始 TipTap JSON
        ↘
         WebSocket 連線 → Hocuspocus + AuthenticationExtension → 驗證權限
                          ↘
                           PersistenceExtension
                             ├─ page.ydoc? → 還原 → 轉 JSON → ContentTransformer → 再轉回 Y.Doc
                             └─ page.content → ContentTransformer → 轉 Y.Doc
                          ↘
                           回傳協作狀態給瀏覽器

IndexeddbPersistence（可選） ←→ HocuspocusProvider（連線事件） ←→ PageEditor UI
```

掌握上述流程後，就能快速鎖定「資料從哪裡來、經過哪些轉換、為什麼需要 Y.Doc」等問題，協作環境出狀況時也能迅速定位。 若未來再新增第三方儲存或額外的內容過濾，只需記得在所有輸出路徑都套用相同的轉換即可。

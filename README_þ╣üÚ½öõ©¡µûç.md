# iPhone 可安裝六合彩 PWA（雲端版）

## 功能
- iPhone Safari 加入主畫面，PWA standalone 模式。
- Email magic-link 登入 Supabase。
- 每個帳戶獨立儲存歷史開獎資料及推薦結果（RLS）。
- 只在開啟時檢查最新資料；亦可手動更新。
- CSV 歷史匯入／匯出、頻率統計、五組六號推薦、walk-forward 回測。
- HKJC GraphQL 更新由 Supabase Edge Function 代理，避免 iOS Safari 直接跨來源請求。

## 重要：這是可部署的完整專案，不是已代你建立的雲端服務
我不能替你開設 Supabase 帳戶或取得你的專案金鑰。首次部署需要你完成以下設定；之後才是真正可登入及雲端同步的版本。

## A. 建立 Supabase 雲端專案
1. 到 https://supabase.com/ 建立免費專案。
2. 在 Project Settings → API，複製 Project URL 和 anon/public key。
3. 編輯 `config.js`，填入：
   - `SUPABASE_URL`
   - `SUPABASE_ANON_KEY`
   **只可使用 anon/public key；絕不可放 service_role key。**
4. Supabase → SQL Editor，執行 `supabase/schema.sql`。
5. Authentication → URL Configuration，將部署網站 URL 加入 Site URL / Redirect URLs（例如 `https://YOURNAME.github.io/marksix-pwa/`）。按需要設定 Email provider。

## B. 部署更新函數
建議使用 Supabase CLI：
```bash
npm install -g supabase
supabase login
supabase link --project-ref YOUR_PROJECT_REF
supabase functions deploy sync-hkjc
```
Edge Function 會使用 Supabase 預設環境變數及已登入使用者 JWT。不要設定或公開 service_role key。
HKJC GraphQL query 是非正式文件介面；HKJC 可隨時更改或限制。若更新失敗，現有資料不會刪除，請匯入 CSV 或稍後重試。

## C. 部署 PWA 靜態檔案（HTTPS 必需）
可用 GitHub Pages：
1. 建立私人或公開 GitHub repository，將本資料夾內檔案上載至 repository root。
2. 在 GitHub Pages 設定部署來源。
3. 確認 `config.js` 已填妥 Supabase 連線資料。
4. 開啟 Pages 提供的 HTTPS 網址。

PWA Service Worker 需要 HTTPS（或 localhost）；不能直接用 iPhone 的 `file://` 開啟安裝。

## D. iPhone 安裝及使用
1. 用 iPhone Safari 開啟已部署 HTTPS 網址。
2. 點分享 →「加入主畫面」→ 加入。
3. 從主畫面開啟，輸入電郵，開啟登入連結完成登入。
4. 首次使用：匯入歷史 CSV（欄位可用 `draw_id,date,n1,n2,n3,n4,n5,n6`）。
5. 之後每次開啟會檢查最新開獎；亦可按「更新最新開獎」手動同步。

## CSV 格式
```csv
draw_id,date,n1,n2,n3,n4,n5,n6
2026/001,2026-01-03,1,8,15,22,31,49
```
以上只示範欄位格式，號碼是假資料，不可當作真實開獎紀錄。匯入會按 `user_id + draw_id` 去重。

## 模型與限制
- 模型版本 `weighted-v1`：長期頻率、近 50 期頻率、遺漏期數、奇偶／高低／和值分佈；生成五組六號並限制組合重疊。
- 回測採 walk-forward 方式，逐期只用當時以前的資料，並與五組隨機號碼作參考比較。
- 目前推薦演算法是可解釋的統計啟發式模型，不是已訓練的機器學習模型。
- 彩票每期獨立隨機，歷史模式不構成未來中獎優勢。回測只描述歷史樣本，不代表未來表現。
- iOS PWA 不保證背景執行；此專案按「開啟時更新」設計。
- HKJC 公開 GraphQL 端點及欄位結構未承諾穩定。上線前必須實測更新函數；目前不能保證端點永遠可用。

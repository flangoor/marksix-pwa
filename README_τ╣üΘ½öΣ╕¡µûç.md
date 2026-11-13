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

## Quantitative Engine v2（新增）
- 部署前先在 Supabase SQL Editor 執行 `supabase/migrations/202611130001_quant_engine_v2.sql`。此遷移可重複執行，保留舊帳戶、歷史開獎及推薦資料；只新增期別狀態、資料表與版本觸發器。`draws` 的號碼只允許全部為 `NULL` 且狀態為 `PRE_DRAW`；其他狀態由 Check Constraint 強制要求六個號碼及日期。
- 再部署 `sync-hkjc` Edge Function，並發布包含 `engine-v2.js` 的 PWA 靜態檔案。
- CSV 匯入、歷史修正及模型版本改變會完整重算；單一期號新增可沿用統計快照增量更新。銷售／派彩更新會記錄資料版本並刷新計算。
- 修改特徵、權重或校準規則時，需同步遞增 `engine-v2.js` 的 `MODEL_VERSION`，由版本不符觸發完整重算。
- 生命週期為 `PRE_DRAW`、`NUMBERS_ONLY`、`PRIZE_DATA_READY`、`MODEL_UPDATED`。派彩和中獎單位保留原始數值；未知值用 JSON `null`，不轉成零。
- HKJC 同步會查詢最近開獎以及未來 14 日日期範圍，嘗試保存官方 `totalInvestment`、`jackpot`、`unitBet`、`estimatedPrize`、`derivedFirstPrizeDiv`、snowball code/name 和各獎級 dividend／winningUnit。下一期預售資料會先以 `PRE_DRAW` 和空號碼儲存。端點是非正式介面，部署後需確認欄位語意與格式；目前查詢沒有已驗證的 Snowball Pool 金額欄位，因此 `snowball_amount` 保持 `NULL`，不會以 jackpot 欄位冒充。
- Pre-Draw 金多寶及投注額可保存，但目前缺少經驗證的七獎級派彩分布及校準信賴區間，因此 gatekeeper 保守回報 `UNCERTAIN`；未配置校準模型前不會輸出正 EV／SKIP 結論。
- Anti-Crowd 使用頭三獎歷史實際中獎單位，對照「總投注額 ÷ 每單位投注額 × 該獎級理論中獎率」的 Poisson 預期注數，並以號碼形態分組作收縮估計。UI 標示「基於歷史派彩分薄程度之代理估計（Proxy Estimate）」；它不是玩家實際投注分布，樣本少時尤其不穩定，也不會改變抽中機率。
- Wheeling 目前提供母池 6 至 18 個號碼的完整六號組合 wheel，精確枚舉母池內的六號結果覆蓋率及總成本。預算不足時會明確指出完整 wheel 不可負擔；不會把未求解的縮減 wheel 宣稱為已驗證。
- 本版沒有設定外部排程；同步仍在 PWA 開啟或手動更新時執行。資料庫遷移及 Edge Function 尚未部署到任何 Supabase 專案。

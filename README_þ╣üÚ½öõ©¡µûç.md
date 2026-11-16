# iPhone 可安裝六合彩 PWA（雲端版）

## 功能
- iPhone Safari 加入主畫面，PWA standalone 模式。
- Email magic-link 登入 Supabase。
- 每個帳戶獨立儲存歷史開獎資料及推薦結果（RLS）。
- 首次開啟自動回填 HKJC 可取得的歷史開獎；之後在開啟時自動增量同步。
- 可設定 Supabase Cron 每 6 小時執行伺服器端增量同步。
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
4. 首次登入會自動回填歷史開獎，之後每次開啟會自動同步；毋須手動匯入 CSV。CSV 匯入保留作選用備份。
5. 按「更新最新開獎」可手動重試同步。

## 自動歷史同步設定
1. 執行 `supabase/migrations/202611160001_historical_sync.sql`，新增每個帳戶的同步狀態表；不會刪除或改寫現有帳戶及開獎資料。
2. 部署 `sync-hkjc` Edge Function。`supabase/config.toml` 關閉 API 閘道預設 JWT 檢查；函數仍會自行驗證登入使用者 JWT，排程請求則以獨立 secret 驗證。
3. 在 Supabase Edge Function Secrets 設定隨機高熵 `SYNC_CRON_SECRET`。
4. 在 Supabase Vault 儲存 `marksix_project_url`、`marksix_anon_key`、`marksix_sync_cron_secret`，最後一項須與 Edge Function secret 相同。不要將 service-role key 放入前端或排程請求。
5. 在 SQL Editor 執行 `supabase/setup/schedule-hkjc-sync.sql`，建立每 6 小時的 Supabase Cron job；再檢查 `cron.job` 的 job 是否 `active`，並在第一次排程後檢查 `cron.job_run_details` 成功紀錄。

首次回填按季度查詢 HKJC 日期範圍，遇到疑似結果上限時拆成月份，並以最近 50 期查詢交叉補漏。之後排程查最近 90 日及最新 50 期。結果按期號去重並重試暫時性錯誤；日期區間持續失敗時該次同步會失敗，現有資料不刪除。PWA 顯示同步狀態及實際涵蓋的最舊／最新日期。

本次實測 HKJC 日期查詢在 1975、1976、1992 年沒有回傳紀錄，1993 年第一季回傳 24 期；首次回填因此從 1993 年開始。更早的開獎如使用者已有 CSV 或舊資料，會保留並繼續納入長期分布。

此自動化依賴 HKJC 未承諾穩定的 GraphQL 介面；顯示的覆蓋日期來自 HKJC 實際回傳，並非 HKJC 對更早資料完整性的保證。開獎號碼與官方投注額／派彩分開保存；來源未提供的獎金欄位保留未知，不會填成零或估造。只有在 Supabase Cron 顯示 job 已啟用且至少有一次成功執行後，才算背景同步已運作。

## CSV 格式
```csv
draw_id,date,n1,n2,n3,n4,n5,n6
2026/001,2026-01-03,1,8,15,22,31,49
```
以上只示範欄位格式，號碼是假資料，不可當作真實開獎紀錄。匯入會按 `user_id + draw_id` 去重。

## 模型與限制
- 長期頻率使用所有已同步歷史；中期窗口可選 100／150／200 期，短期可選 20／35／50 期；另計遺漏期數、奇偶／高低／和值分佈。
- 回測按日期由舊至新 walk-forward；每期只使用之前的開獎與派彩資料，不讀取該期或未來資料，並與五組隨機號碼作參考比較。
- 目前推薦演算法是可解釋的統計啟發式模型，不是已訓練的機器學習模型。
- 彩票每期獨立隨機，歷史模式不構成未來中獎優勢。回測只描述歷史樣本，不代表未來表現。
- 背景排程需完成上方 Edge Function secret、Supabase Vault secret 及 Cron job 設定；只有確認 Cron job 啟用且 HTTP 同步回報成功後，才算背景同步正常。
- HKJC 公開 GraphQL 端點及欄位結構未承諾穩定。上線前必須實測更新函數；目前不能保證端點永遠可用。

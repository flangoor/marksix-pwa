(() => {
"use strict";

const cfg = window.MARKSIX_CONFIG || {};
const $ = id => document.getElementById(id);

const configured =
  cfg.SUPABASE_URL?.startsWith("https://") &&
  !cfg.SUPABASE_URL.includes("YOUR-") &&
  cfg.SUPABASE_ANON_KEY &&
  !cfg.SUPABASE_ANON_KEY.includes("YOUR_");

let sb, user, draws = [], picks = [];
let activeBootUserId = null;
const engine = window.MarkSixEngineV2;
let crowdModel = engine.buildCrowdProxyModel([]);

const show = (id, on = true) =>
  $(id).classList.toggle("hidden", !on);

const msg = s => $("status").textContent = s;

const redirectUrl =
  window.location.origin + window.location.pathname;

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js").catch(() => {});
  });
}

// ----------------------------------------
// Supabase initialization and authentication
// ----------------------------------------

if (!configured) {
  $("authMsg").textContent =
    "請先在 config.js 填入 Supabase URL 及 Publishable Key。";

  $("sendLink").disabled = true;
  $("googleLogin").disabled = true;

} else {

  sb = window.supabase.createClient(
    cfg.SUPABASE_URL,
    cfg.SUPABASE_ANON_KEY
  );

  // Process authentication events outside the Supabase callback.
  sb.auth.onAuthStateChange((event, session) => {
    queueMicrotask(() => {
      handleAuthState(session);
    });
  });
}

async function handleAuthState(session) {

  if (session?.user) {

    user = session.user;

    // Avoid booting twice for the same login session.
    if (activeBootUserId === user.id) return;

    activeBootUserId = user.id;

    try {
      await boot();
    } catch (error) {
      msg("載入資料失敗：" + (error.message || String(error)));
    }

  } else {

    user = null;
    activeBootUserId = null;

    show("authPanel");
    show("appPanel", false);
    show("resultsPanel", false);
    show("statsPanel", false);
    show("backtestPanel", false);
    show("preDrawPanel", false);
    show("wheelPanel", false);

    $("cloudState").textContent = "未登入";
  }
}

// ----------------------------------------
// Google OAuth login
// ----------------------------------------

$("googleLogin").onclick = async () => {

  if (!sb) return;

  const button = $("googleLogin");

  button.disabled = true;
  button.textContent = "正在連接 Google…";
  $("authMsg").textContent = "";

  try {

    const { error } = await sb.auth.signInWithOAuth({
      provider: "google",
      options: {
        redirectTo: redirectUrl,
        queryParams: {
          prompt: "select_account"
        }
      }
    });

    if (error) throw error;

  } catch (error) {

    $("authMsg").textContent =
      "Google 登入失敗：" + (error.message || String(error));

    button.disabled = false;
    button.textContent = "使用 Google 帳戶登入";
  }
};

// ----------------------------------------
// Magic Link login (preserved)
// ----------------------------------------

$("sendLink").onclick = async () => {

  const email = $("email").value.trim();

  if (!email) {
    $("authMsg").textContent = "請輸入電郵。";
    return;
  }

  if (!sb) return;

  $("sendLink").disabled = true;

  try {

    const { error } = await sb.auth.signInWithOtp({
      email,
      options: {
        emailRedirectTo: redirectUrl
      }
    });

    $("authMsg").textContent = error
      ? error.message
      : "登入連結已寄出，請在此裝置開啟電郵連結。";

  } catch (error) {

    $("authMsg").textContent =
      error.message || String(error);

  } finally {

    $("sendLink").disabled = false;
  }
};

// ----------------------------------------
// Logout
// ----------------------------------------

$("logout").onclick = async () => {

  if (!sb) return;

  const { error } = await sb.auth.signOut();

  if (error) {
    msg("登出失敗：" + error.message);
  }
};

// ----------------------------------------
// Main application
// ----------------------------------------

async function boot() {

  show("authPanel", false);
  show("appPanel");
  show("resultsPanel");
  show("statsPanel");
  show("backtestPanel");
  show("preDrawPanel");
  show("wheelPanel");

  $("cloudState").textContent = "雲端已連接";

  await loadDraws();
  await loadPicks();

  render();

  if (draws.length === 0) {
    msg("雲端帳戶已連接。請先匯入歷史 CSV，或按更新最新開獎。");
  } else {
    msg("已載入雲端資料。正在檢查最新一期…");
  }

  await sync(false);
}

// ----------------------------------------
// Load historical draws
// ----------------------------------------

async function loadDraws() {

  let all = [];
  let from = 0;

  while (true) {

    const { data, error } = await sb
      .from("draws")
      .select("*")
      .order("draw_date", { ascending: true })
      .range(from, from + 999);

    if (error) {
      msg("讀取歷史資料失敗：" + error.message);
      break;
    }

    all = all.concat(data || []);

    if (!data || data.length < 1000) break;

    from += 1000;
  }

  draws = all.map(d => ({
    id: d.draw_id,
    date: d.draw_date,
    extra: d.extra == null ? null : Number(d.extra),
    lifecycleState: d.lifecycle_state || "NUMBERS_ONLY",
    nums: [
      d.n1, d.n2, d.n3,
      d.n4, d.n5, d.n6
    ].map(Number)
  })).filter(d => valid(d.nums));
  await loadCrowdProxyHistory();

  $("dbInfo").textContent =
    `雲端歷史：${draws.length.toLocaleString()} 期` +
    (draws.length
      ? ` · 最近 ${draws.at(-1).date}`
      : "");

  if (draws.length && user) {
    const { data: market } = await sb.from("draw_market_data").select("lifecycle_state").eq("user_id", user.id).eq("draw_id", draws.at(-1).id).maybeSingle();
    const state = market?.lifecycle_state || draws.at(-1).lifecycleState || "NUMBERS_ONLY";
    $("dbInfo").textContent += ` · 資料狀態 ${state}`;
  }
}

async function loadCrowdProxyHistory() {
  const byId = new Map(draws.map(d => [d.id, d]));
  const records = [];
  let from = 0;
  try {
    while (true) {
      const { data, error } = await sb.from("draw_market_data").select("draw_id,actual_sales,unit_bet,prize_data").eq("user_id", user.id).range(from, from + 999);
      if (error) throw error;
      for (const row of data || []) {
        const draw = byId.get(row.draw_id);
        if (draw && row.actual_sales != null && row.unit_bet != null && Array.isArray(row.prize_data)) {
          records.push({ id: row.draw_id, nums: draw.nums, date: draw.date, sales: Number(row.actual_sales), unitBet: Number(row.unit_bet), prizes: row.prize_data });
        }
      }
      if (!data || data.length < 1000) break;
      from += 1000;
    }
    crowdModel = engine.buildCrowdProxyModel(records);
  } catch {
    crowdModel = engine.buildCrowdProxyModel([]);
  }
}

function valid(a) {

  return (
    a?.length === 6 &&
    a.every(n =>
      Number.isInteger(n) &&
      n >= 1 &&
      n <= 49
    ) &&
    new Set(a).size === 6
  );
}

function prizeDivision(type) {
  const value = String(type ?? "").toLowerCase();
  const match = value.match(/(?:^|\D)([1-7])(?:\D|$)/);
  if (match) return Number(match[1]);
  if (value.includes("first")) return 1;
  if (value.includes("second")) return 2;
  if (value.includes("third")) return 3;
  return null;
}

function mergePrizeData(previous, incoming) {
  const oldByType = new Map((Array.isArray(previous) ? previous : []).map(p => [String(p.type), p]));
  const newRows = Array.isArray(incoming) ? incoming : [];
  if (!newRows.length) return Array.isArray(previous) && previous.length ? previous : null;
  const merged = newRows.map(p => {
    const old = oldByType.get(String(p.type));
    return {
      ...old,
      ...p,
      winningUnit: p.winningUnit == null ? (old?.winningUnit ?? null) : p.winningUnit,
      dividend: p.dividend == null ? (old?.dividend ?? null) : p.dividend
    };
  });
  for (const [type, old] of oldByType) if (!merged.some(p => String(p.type) === type)) merged.push(old);
  return merged;
}

// ----------------------------------------
// Sync latest HKJC draws
// ----------------------------------------

async function sync(showMessage = true) {

  if (!user) return;

  if (showMessage) {
    msg("正在向 HKJC 公開資料介面查詢…");
  }

  try {

    const {
      data: { session }
    } = await sb.auth.getSession();

    const { data, error } =
      await sb.functions.invoke("sync-hkjc", {
        body: {}
      });

    if (error) throw error;

    const rows = data?.draws || [];
    const preDrawRows = data?.preDraws || [];
    const previousIds = new Set(draws.map(d => d.id));

    if (rows.length) {

      const payload = rows
        .filter(r => valid(r.numbers))
        .map(r => ({
          user_id: user.id,
          draw_id: String(r.id),
          draw_date: r.date,
          n1: r.numbers[0],
          n2: r.numbers[1],
          n3: r.numbers[2],
          n4: r.numbers[3],
          n5: r.numbers[4],
          n6: r.numbers[5],
          extra: r.extra ?? null,
          source: "HKJC GraphQL"
        }));

      const { data: existingDrawStates, error: stateError } = await sb.from("draws").select("draw_id,lifecycle_state").eq("user_id", user.id).in("draw_id", payload.map(r => r.draw_id));
      if (stateError) throw stateError;
      const stateById = new Map((existingDrawStates || []).map(d => [d.draw_id, d.lifecycle_state]));
      payload.forEach(r => {
        const previousState = stateById.get(r.draw_id);
        r.lifecycle_state = previousState && previousState !== "PRE_DRAW" ? previousState : "NUMBERS_ONLY";
      });

      if (payload.length) {

        const { error: e } = await sb
          .from("draws")
          .upsert(payload, {
            onConflict: "user_id,draw_id"
          });

        if (e) throw e;
      }
      await saveOfficialMarketRows(rows, data?.observedAt);
    }

    if (preDrawRows.length) {
      await savePreDrawRows(preDrawRows, data?.observedAt);
      const next = [...preDrawRows].sort((a, b) => String(a.date).localeCompare(String(b.date)))[0];
      if (next) {
        $("preDrawId").value = String(next.id);
        if (next.date) $("preDrawDate").value = next.date;
        if (next.jackpot != null) $("preDrawJackpot").value = next.jackpot;
        if (next.totalInvestment != null) $("preDrawSales").value = next.totalInvestment;
        if (next.unitBet != null) $("preDrawCost").value = next.unitBet;
        $("preDrawResult").textContent = `已同步 HKJC 下一期預售資料 ${String(next.id)}；仍需完成經校準派彩模型才可判定 EV。`;
      }
    }

    await loadDraws();
    const added = rows.some(r => !previousIds.has(String(r.id)));
    await generate({ forceFull: false, reason: added ? "new_draw_received" : "hkjc_sync_completed" });
    render();

    const syncNotices = [];
    if (data?.preDrawWarning) syncNotices.push("下一期查詢暫不可用");
    if (data?.snowballAmountNote) syncNotices.push("HKJC 回應未提供已驗證的金多寶基金金額欄位");
    msg(
      `同步完成：HKJC 回傳 ${rows.length} 期；下一期預售資料 ${preDrawRows.length} 期；` +
      `雲端共 ${draws.length} 期。` + (syncNotices.length ? ` 備註：${syncNotices.join("；")}。` : "")
    );

  } catch (e) {

    msg(
      "同步未成功：" +
      (e.message || String(e)) +
      "。現有雲端資料保留不變；可稍後重試或匯入 CSV。"
    );
  }
}

$("sync").onclick = () => sync(true);

$("generate").onclick = async () => {

  await generate({ reason: "manual_reanalysis" });
  render();

  msg("已重新分析並儲存推薦結果。");
};

$("savePreDraw").onclick = async () => {
  if (!user) return;
  const drawId = $("preDrawId").value.trim();
  const drawDateInput = $("preDrawDate").value || null;
  const jackpot = Number($("preDrawJackpot").value);
  const sales = Number($("preDrawSales").value);
  const ticketCost = Number($("preDrawCost").value);
  if (!drawId || !$("preDrawJackpot").value || !$("preDrawSales").value || !$("preDrawCost").value) {
    $("preDrawResult").textContent = "請填寫期號、金多寶估算、投注額估算及每注成本。";
    return;
  }
  if (!Number.isFinite(jackpot) || jackpot < 0 || !Number.isFinite(sales) || sales < 0 || !Number.isFinite(ticketCost) || ticketCost <= 0) {
    $("preDrawResult").textContent = "金多寶及投注額須為零或正數；每注成本必須大於零。";
    return;
  }
  const { data: existing, error: readError } = await sb.from("draw_market_data").select("*").eq("user_id", user.id).eq("draw_id", drawId).maybeSingle();
  if (readError) { $("preDrawResult").textContent = "讀取失敗：" + readError.message; return; }
  const { data: existingDraw, error: drawReadError } = await sb.from("draws").select("draw_id,draw_date,lifecycle_state,n1,n2,n3,n4,n5,n6").eq("user_id", user.id).eq("draw_id", drawId).maybeSingle();
  if (drawReadError) { $("preDrawResult").textContent = "讀取期別失敗：" + drawReadError.message; return; }
  const drawDate = drawDateInput || existingDraw?.draw_date || null;
  const observedAt = new Date().toISOString();
  const gate = engine.preDrawGate({ ticketCost, jackpot, estimatedSales: sales });
  if (!existingDraw) {
    const { error: drawInsertError } = await sb.from("draws").insert({ user_id: user.id, draw_id: drawId, draw_date: drawDate, lifecycle_state: "PRE_DRAW", n1: null, n2: null, n3: null, n4: null, n5: null, n6: null, extra: null, source: "Pre-draw estimate" });
    if (drawInsertError) { $("preDrawResult").textContent = "保存 PRE_DRAW 期別失敗：" + drawInsertError.message; return; }
  } else if (existingDraw.lifecycle_state === "PRE_DRAW" && drawDate !== existingDraw.draw_date) {
    const { error: dateError } = await sb.from("draws").update({ draw_date: drawDate }).eq("user_id", user.id).eq("draw_id", drawId);
    if (dateError) { $("preDrawResult").textContent = "更新預定日期失敗：" + dateError.message; return; }
  }
  const estimateFields = {
    estimated_jackpot: jackpot, estimated_sales: sales, estimated_ticket_cost: ticketCost,
    field_sources: { ...(existing?.field_sources || {}), estimated_jackpot: { source: "user/model estimate", observed_at: observedAt }, estimated_sales: { source: "user/model estimate", observed_at: observedAt }, estimated_ticket_cost: { source: "user/model estimate", observed_at: observedAt } },
    data_version: Number(existing?.data_version || 0) + 1, updated_at: observedAt
  };
  const write = existing
    ? await sb.from("draw_market_data").update(estimateFields).eq("user_id", user.id).eq("draw_id", drawId)
    : await sb.from("draw_market_data").insert({ user_id: user.id, draw_id: drawId, lifecycle_state: existingDraw?.lifecycle_state && existingDraw.lifecycle_state !== "PRE_DRAW" ? existingDraw.lifecycle_state : "PRE_DRAW", ...estimateFields });
  const error = write.error;
  if (error) {
    $("preDrawResult").textContent = "保存失敗：" + error.message + "。請確認已套用資料庫遷移。";
    return;
  }
  let resultText = gate.decision + "：" + gate.reason;
  if (gate.ev != null) resultText += " 預估 EV " + gate.ev.toFixed(2) + " 元；ROI " + (gate.roi * 100).toFixed(1) + "%。";
  $("preDrawResult").textContent = "PRE_DRAW 已保存 · " + resultText;
  const { data: versionRow } = await sb.from("engine_data_versions").select("current_version").eq("user_id", user.id).maybeSingle();
  const { error: runError } = await sb.from("engine_runs").insert({ user_id: user.id, run_mode: "PRE_DRAW", trigger_reason: "pre_draw_gatekeeper", draw_id: drawId, model_version: engine.MODEL_VERSION, data_version: Number(versionRow?.current_version || 0), status: "COMPLETED", result_summary: { ...gate, inputs: { jackpot, estimatedSales: sales, ticketCost } }, started_at: observedAt, completed_at: new Date().toISOString() });
  if (runError) $("preDrawResult").textContent += "（計算紀錄未保存；請套用資料庫遷移。）";
};

$("buildWheel").onclick = () => {
  try {
    const pool = $("wheelPool").value.split(/[\s,，;；]+/).filter(Boolean).map(Number);
    const costValue = $("wheelTicketCost").value;
    const budgetValue = $("wheelBudget").value;
    const result = engine.fullWheel(pool, { ticketCost: costValue === "" ? null : Number(costValue), budget: budgetValue === "" ? null : Number(budgetValue) });
    if (result.totalCost !== null && result.withinBudget === false) {
      $("wheelResult").textContent = "完整 wheel 需要 " + result.ticketCount.toLocaleString() + " 注，共 " + result.totalCost.toLocaleString() + " 元，超出預算；本工具不會把未求解的縮減 wheel 標成已驗證覆蓋率。" + result.guarantee;
    } else {
      $("wheelResult").textContent = result.poolSize + " 個母池號碼，" + result.ticketCount.toLocaleString() + " 注；母池內六號結果覆蓋 " + result.coveredOutcomes.toLocaleString() + " / " + result.totalPoolOutcomes.toLocaleString() + " (" + (result.coverageWithinPool * 100).toFixed(2) + "%)。" + (result.totalCost == null ? "" : " 總成本 " + result.totalCost.toLocaleString() + " 元。") + result.guarantee;
    }
    $("wheelTickets").textContent = result.tickets.slice(0, 50).map(t => t.join(" ")).join("\n") + (result.tickets.length > 50 ? "\n…其餘 " + (result.tickets.length - 50) + " 注" : "");
  } catch (e) { $("wheelResult").textContent = e.message; $("wheelTickets").textContent = ""; }
};

// ----------------------------------------
// Number scoring model
// ----------------------------------------

function scoreSet(set, features) {

  const recent = Array(50).fill(0);
  (features.recent || []).forEach(draw => draw.forEach(n => recent[n]++));
  const freq = features.frequency;
  const gap = features.gap;

  const f = set.reduce((s, n) =>
    s +
    Math.log1p(freq[n]) * 1.3 +
    Math.log1p(recent[n]) * 1.1 +
    Math.min(gap[n], 35) * 0.035,
    0
  );

  const odd = set.filter(n => n % 2).length;
  const low = set.filter(n => n <= 24).length;
  const sum = set.reduce((a, b) => a + b, 0);

  return (
    f -
    Math.abs(odd - 3) * 0.65 -
    Math.abs(low - 3) * 0.45 -
    Math.abs(sum - 150) * 0.012
  );
}

function generatePicks(history, candidateCount = 7000, features = engine.fullFeatures(history)) {

  if (history.length < 10) return [];

  const candidates = [];

  for (let k = 0; k < candidateCount; k++) {

    const a = [];

    while (a.length < 6) {

      const n = 1 + Math.floor(Math.random() * 49);

      if (!a.includes(n)) a.push(n);
    }

    a.sort((x, y) => x - y);

    const crowdEstimate = engine.crowdProxy(a, crowdModel);
    candidates.push({
      nums: a,
      score: scoreSet(a, features) - crowdEstimate.riskScore * 0.15,
      crowdRisk: crowdEstimate.riskScore,
      crowdEstimate
    });
  }

  candidates.sort((a, b) => b.score - a.score);

  const out = [];

  for (const c of candidates) {

    if (
      out.every(p =>
        p.nums.filter(n => c.nums.includes(n)).length <= 3
      )
    ) {

      out.push(c);

      if (out.length === 5) break;
    }
  }

  return out;
}

// ----------------------------------------
// Generate and save recommendations
// ----------------------------------------

async function generate(options = {}) {

  const forceFull = options.forceFull === true;
  let featureSet = null;
  let mode = "FULL_RECALCULATION";
  let dataVersion = draws.length;
  let drawVersion = draws.length;
  let runError = null;

  if (user) {
    try {
      const [{ data: versionRow, error: versionError }, { data: previousRows, error: previousError }] = await Promise.all([
        sb.from("engine_data_versions").select("current_version,draw_version,market_version").eq("user_id", user.id).maybeSingle(),
        sb.from("engine_feature_snapshots").select("data_version,features,model_version").eq("user_id", user.id).eq("feature_key", "number_stats").order("calculated_at", { ascending: false }).limit(1)
      ]);
      if (versionError) throw versionError;
      if (previousError) throw previousError;
      dataVersion = Number(versionRow?.current_version ?? draws.length);
      drawVersion = Number(versionRow?.draw_version ?? draws.length);
      const previous = previousRows?.[0];
      if (!forceFull && previous?.model_version === engine.MODEL_VERSION) {
        if (Number(previous.data_version) === drawVersion && Number(previous.features?.drawCount) === draws.length) {
          featureSet = previous.features;
          mode = "INCREMENTAL";
        } else if (Number(previous.data_version) + 1 === drawVersion && Number(previous.features?.drawCount) + 1 === draws.length && draws[Number(previous.features.drawCount) - 1]?.id === previous.features.throughDrawId) {
          featureSet = engine.addDraw(previous.features, draws.at(-1));
          mode = "INCREMENTAL";
        }
      }
      if (featureSet) featureSet.dataVersion = drawVersion;
    } catch (e) {
      runError = e.message || String(e);
      featureSet = engine.fullFeatures(draws);
      mode = "FULL_RECALCULATION";
    }
  }

  if (forceFull || !featureSet) {
    featureSet = engine.fullFeatures(draws);
    mode = "FULL_RECALCULATION";
  }
  featureSet.dataVersion = drawVersion;
  picks = generatePicks(draws, 7000, featureSet);

  if (!user || !picks.length) return;

  const { error } = await sb
    .from("recommendations")
    .insert({
      user_id: user.id,
      as_of_draw: draws.at(-1)?.id || null,
      combinations: picks.map(p => p.nums),
      model_version: engine.MODEL_VERSION
    });

  if (error) {
    msg("推薦已計算，但雲端儲存失敗：" + error.message);
  }

  await recordEngineRun({ mode, reason: options.reason || (forceFull ? "historical_csv_import" : "recommendation_refresh"), dataVersion, featureSet, runError });
}

async function recordEngineRun({ mode, reason, dataVersion, featureSet, runError }) {
  const throughDraw = draws.at(-1)?.id || null;
  const featureRow = { user_id: user.id, feature_key: "number_stats", through_draw_id: throughDraw, data_version: Number(featureSet.dataVersion ?? dataVersion), model_version: engine.MODEL_VERSION, features: featureSet };
  const { error: snapshotError } = await sb.from("engine_feature_snapshots").upsert(featureRow, { onConflict: "user_id,feature_key,data_version,model_version" });
  const runRow = { user_id: user.id, run_mode: mode, trigger_reason: reason, draw_id: throughDraw, model_version: engine.MODEL_VERSION, data_version: dataVersion, status: runError || snapshotError ? "FAILED" : "COMPLETED", result_summary: { recommendationCount: picks.length, drawCount: draws.length, drawVersion: featureRow.data_version }, error_message: runError || snapshotError?.message || null, started_at: new Date().toISOString(), completed_at: new Date().toISOString() };
  const { error: runErrorResult } = await sb.from("engine_runs").insert(runRow);
  if (runErrorResult && !runError && !snapshotError) msg("計算已完成；請先套用 Quantitative Engine v2 資料庫遷移以儲存計算紀錄。");
  if (throughDraw && !runError && !snapshotError && !runErrorResult) {
    const { data: updatedMarket } = await sb.from("draw_market_data").update({ lifecycle_state: "MODEL_UPDATED" }).eq("user_id", user.id).eq("draw_id", throughDraw).eq("lifecycle_state", "PRIZE_DATA_READY").select("draw_id");
    if (updatedMarket?.length) {
      await sb.from("draws").update({ lifecycle_state: "MODEL_UPDATED" }).eq("user_id", user.id).eq("draw_id", throughDraw).eq("lifecycle_state", "PRIZE_DATA_READY");
      $("dbInfo").textContent = $("dbInfo").textContent.replace("資料狀態 PRIZE_DATA_READY", "資料狀態 MODEL_UPDATED");
    }
  }
}

async function saveOfficialMarketRows(rows, observedAt) {
  const ids = rows.map(r => String(r.id));
  if (!ids.length) return;
  const { data: previous, error: readError } = await sb.from("draw_market_data").select("*").eq("user_id", user.id).in("draw_id", ids);
  if (readError) throw readError;
  const oldById = new Map((previous || []).map(r => [r.draw_id, r]));
  const payload = rows.map(r => {
    const old = oldById.get(String(r.id)) || {};
    const prizes = Array.isArray(r.prizes) ? r.prizes : [];
    const prizeByDivision = new Map(prizes.map(p => [prizeDivision(p.type), p]).filter(([division]) => division));
    const savedPrizes = mergePrizeData(old.prize_data, prizes);
    const effectivePrizes = savedPrizes || [];
    const complete = effectivePrizes.length > 0 && effectivePrizes.every(p => p.winningUnit != null && p.dividend != null);
    const proposedState = engine.lifecycleState({ numbersReady: true, prizeData: complete ? effectivePrizes : null });
    const sales = r.totalInvestment ?? old.actual_sales ?? null;
    const jackpot = r.jackpot ?? old.official_jackpot ?? null;
    const firstPrizeDividend = prizeByDivision.get(1)?.dividend ?? r.firstPrizeDividend ?? old.first_prize_dividend ?? null;
    const secondPrizeDividend = prizeByDivision.get(2)?.dividend ?? old.second_prize_dividend ?? null;
    const thirdPrizeDividend = prizeByDivision.get(3)?.dividend ?? old.third_prize_dividend ?? null;
    const firstPrizeUnits = prizeByDivision.get(1)?.winningUnit ?? old.first_prize_winning_units ?? null;
    const secondPrizeUnits = prizeByDivision.get(2)?.winningUnit ?? old.second_prize_winning_units ?? null;
    const thirdPrizeUnits = prizeByDivision.get(3)?.winningUnit ?? old.third_prize_winning_units ?? null;
    const sameNumber = (a, b) => (a == null && b == null) || (Number(a) === Number(b));
    const officialDataChanged = !sameNumber(old.actual_sales, sales) || !sameNumber(old.official_jackpot, jackpot) || !sameNumber(old.unit_bet, r.unitBet ?? old.unit_bet ?? null) || !sameNumber(old.estimated_prize, r.estimatedPrize ?? old.estimated_prize ?? null) || old.snowball_code !== (r.snowballCode ?? old.snowball_code ?? null) || old.snowball_name !== (r.snowballName ?? old.snowball_name ?? null) || old.pool_status !== (r.poolStatus ?? old.pool_status ?? null) || old.pool_sell !== (r.poolSell ?? old.pool_sell ?? null) || !sameNumber(old.first_prize_dividend, firstPrizeDividend) || !sameNumber(old.second_prize_dividend, secondPrizeDividend) || !sameNumber(old.third_prize_dividend, thirdPrizeDividend) || !sameNumber(old.first_prize_winning_units, firstPrizeUnits) || !sameNumber(old.second_prize_winning_units, secondPrizeUnits) || !sameNumber(old.third_prize_winning_units, thirdPrizeUnits) || JSON.stringify(old.prize_data || null) !== JSON.stringify(savedPrizes);
    const state = old.lifecycle_state === "MODEL_UPDATED" && !officialDataChanged ? "MODEL_UPDATED" : proposedState;
    const isChanged = !old.id || officialDataChanged || old.lifecycle_state !== state;
    if (!isChanged) return null;
    const seenAt = observedAt || new Date().toISOString();
    const officialSource = { source: "HKJC public GraphQL", observed_at: seenAt };
    const sourceInfo = { ...(old.field_sources || {}), official_sync: officialSource };
    if (r.totalInvestment !== null && r.totalInvestment !== undefined) sourceInfo.actual_sales = officialSource;
    if (r.jackpot !== null && r.jackpot !== undefined) sourceInfo.official_jackpot = officialSource;
    if (prizeByDivision.has(1) || (r.firstPrizeDividend !== null && r.firstPrizeDividend !== undefined)) sourceInfo.first_prize_dividend = officialSource;
    if (prizeByDivision.has(1)) sourceInfo.first_prize_winning_units = officialSource;
    if (prizeByDivision.has(2)) { sourceInfo.second_prize_dividend = officialSource; sourceInfo.second_prize_winning_units = officialSource; }
    if (prizeByDivision.has(3)) { sourceInfo.third_prize_dividend = officialSource; sourceInfo.third_prize_winning_units = officialSource; }
    if (r.unitBet !== null && r.unitBet !== undefined) sourceInfo.unit_bet = officialSource;
    if (r.estimatedPrize !== null && r.estimatedPrize !== undefined) sourceInfo.estimated_prize = officialSource;
    if (r.snowballCode || r.snowballName) sourceInfo.snowball = officialSource;
    if (prizes.length) sourceInfo.prize_data = officialSource;
    return { ...old, user_id: user.id, draw_id: String(r.id), lifecycle_state: state, actual_sales: sales, official_jackpot: jackpot, snowball_amount: old.snowball_amount ?? null, snowball_code: r.snowballCode ?? old.snowball_code ?? null, snowball_name: r.snowballName ?? old.snowball_name ?? null, unit_bet: r.unitBet ?? old.unit_bet ?? null, pool_status: r.poolStatus ?? old.pool_status ?? null, pool_sell: r.poolSell ?? old.pool_sell ?? null, estimated_prize: r.estimatedPrize ?? old.estimated_prize ?? null, first_prize_dividend: firstPrizeDividend, second_prize_dividend: secondPrizeDividend, third_prize_dividend: thirdPrizeDividend, first_prize_winning_units: firstPrizeUnits, second_prize_winning_units: secondPrizeUnits, third_prize_winning_units: thirdPrizeUnits, estimated_first_prize_dividend: old.estimated_first_prize_dividend ?? null, prize_data: savedPrizes, field_sources: sourceInfo, data_version: Number(old.data_version || 0) + 1, updated_at: new Date().toISOString(), last_error: null };
  }).filter(Boolean);
  if (!payload.length) return;
  const { error } = await sb.from("draw_market_data").upsert(payload, { onConflict: "user_id,draw_id" });
  if (error) throw error;
  for (const state of ["NUMBERS_ONLY", "PRIZE_DATA_READY"]) {
    const stateIds = payload.filter(row => row.lifecycle_state === state).map(row => row.draw_id);
    if (stateIds.length) {
      const { error: stateWriteError } = await sb.from("draws").update({ lifecycle_state: state }).eq("user_id", user.id).in("draw_id", stateIds);
      if (stateWriteError) throw stateWriteError;
    }
  }
}

async function savePreDrawRows(rows, observedAt) {
  const ids = rows.map(r => String(r.id));
  const [{ data: existingDraws, error: drawError }, { data: existingMarkets, error: marketError }] = await Promise.all([
    sb.from("draws").select("draw_id,draw_date,lifecycle_state,n1,n2,n3,n4,n5,n6").eq("user_id", user.id).in("draw_id", ids),
    sb.from("draw_market_data").select("*").eq("user_id", user.id).in("draw_id", ids),
  ]);
  if (drawError) throw drawError;
  if (marketError) throw marketError;
  const drawById = new Map((existingDraws || []).map(d => [d.draw_id, d]));
  const marketById = new Map((existingMarkets || []).map(m => [m.draw_id, m]));
  const drawWrites = [];
  const marketWrites = [];
  const seenAt = observedAt || new Date().toISOString();
  for (const r of rows) {
    const drawId = String(r.id);
    const oldDraw = drawById.get(drawId);
    const oldMarket = marketById.get(drawId) || {};
    if (!oldDraw) {
      drawWrites.push({ user_id: user.id, draw_id: drawId, draw_date: r.date, lifecycle_state: "PRE_DRAW", n1: null, n2: null, n3: null, n4: null, n5: null, n6: null, extra: null, source: "HKJC GraphQL PRE_DRAW" });
    } else if (oldDraw.lifecycle_state === "PRE_DRAW" && r.date && oldDraw.draw_date !== r.date) {
      const { error } = await sb.from("draws").update({ draw_date: r.date }).eq("user_id", user.id).eq("draw_id", drawId);
      if (error) throw error;
    }
    const sameNumber = (a, b) => (a == null && b == null) || Number(a) === Number(b);
    const changed = !oldMarket.id || !sameNumber(oldMarket.estimated_sales, r.totalInvestment ?? oldMarket.estimated_sales ?? null) || !sameNumber(oldMarket.estimated_jackpot, r.jackpot ?? oldMarket.estimated_jackpot ?? null) || !sameNumber(oldMarket.unit_bet, r.unitBet ?? oldMarket.unit_bet ?? null) || !sameNumber(oldMarket.estimated_prize, r.estimatedPrize ?? oldMarket.estimated_prize ?? null) || !sameNumber(oldMarket.estimated_first_prize_dividend, r.firstPrizeDividend ?? oldMarket.estimated_first_prize_dividend ?? null) || oldMarket.snowball_code !== (r.snowballCode ?? oldMarket.snowball_code ?? null) || oldMarket.snowball_name !== (r.snowballName ?? oldMarket.snowball_name ?? null) || oldMarket.pool_status !== (r.poolStatus ?? oldMarket.pool_status ?? null) || oldMarket.pool_sell !== (r.poolSell ?? oldMarket.pool_sell ?? null);
    if (!changed) continue;
    const source = { source: "HKJC GraphQL live pool", observed_at: seenAt };
    const sourceInfo = { ...(oldMarket.field_sources || {}), official_sync: source };
    if (r.totalInvestment !== null) sourceInfo.estimated_sales = source;
    if (r.jackpot !== null) sourceInfo.estimated_jackpot = source;
    if (r.estimatedPrize !== null) sourceInfo.estimated_prize = source;
    if (r.firstPrizeDividend !== null) sourceInfo.estimated_first_prize_dividend = source;
    if (r.unitBet !== null) sourceInfo.unit_bet = source;
    if (r.snowballCode || r.snowballName) sourceInfo.snowball = source;
    const row = {
      ...oldMarket, user_id: user.id, draw_id: drawId,
      lifecycle_state: oldMarket.lifecycle_state && oldMarket.lifecycle_state !== "PRE_DRAW" ? oldMarket.lifecycle_state : (oldDraw?.lifecycle_state && oldDraw.lifecycle_state !== "PRE_DRAW" ? oldDraw.lifecycle_state : "PRE_DRAW"),
      estimated_sales: r.totalInvestment ?? oldMarket.estimated_sales ?? null,
      estimated_jackpot: r.jackpot ?? oldMarket.estimated_jackpot ?? null,
      estimated_ticket_cost: oldMarket.estimated_ticket_cost ?? null,
      snowball_code: r.snowballCode ?? oldMarket.snowball_code ?? null,
      snowball_name: r.snowballName ?? oldMarket.snowball_name ?? null,
      snowball_amount: oldMarket.snowball_amount ?? null,
      unit_bet: r.unitBet ?? oldMarket.unit_bet ?? null,
      estimated_prize: r.estimatedPrize ?? oldMarket.estimated_prize ?? null,
      estimated_first_prize_dividend: r.firstPrizeDividend ?? oldMarket.estimated_first_prize_dividend ?? null,
      pool_status: r.poolStatus ?? oldMarket.pool_status ?? null,
      pool_sell: r.poolSell ?? oldMarket.pool_sell ?? null,
      field_sources: sourceInfo, data_version: Number(oldMarket.data_version || 0) + 1, updated_at: seenAt,
    };
    marketWrites.push(row);
  }
  if (drawWrites.length) {
    const { error } = await sb.from("draws").upsert(drawWrites, { onConflict: "user_id,draw_id" });
    if (error) throw error;
  }
  if (marketWrites.length) {
    const { error } = await sb.from("draw_market_data").upsert(marketWrites, { onConflict: "user_id,draw_id" });
    if (error) throw error;
  }
}

async function loadPicks() {

  if (!user) return;

  const { data } = await sb
    .from("recommendations")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(1);

  if (data?.[0]?.combinations) {

    picks = data[0].combinations.map(nums => ({
      nums,
      score: 0
    }));
  }
}

// ----------------------------------------
// Render dashboard
// ----------------------------------------

function render() {

  const container = $("picks");

  container.innerHTML = "";

  picks.forEach((p, i) => {

    const el = document.createElement("div");

    el.className = "pick";

    el.innerHTML =
      `<strong>${i + 1}</strong>` +
      p.nums.map(n =>
        `<span class="ball">${n}</span>`
      ).join("") +
      (
        p.score
          ? `<small class="muted">模型排序分 ${p.score.toFixed(2)} · ${p.crowdEstimate?.status === "PROXY_ESTIMATE" ? `基於歷史派彩分薄程度之代理估計（Proxy Estimate）：${p.crowdEstimate.predictedMultiplier.toFixed(2)}× 理論泊松注數，${p.crowdEstimate.sampleDraws} 期` : `結構代理 ${p.crowdRisk?.toFixed(2) ?? "—"}（尚無歷史派彩觀測）`}</small>`
          : ""
      );

    container.append(el);
  });

  const n = draws.length;

  $("stats").innerHTML = [
    ["歷史期數", n.toLocaleString()],
    ["最新期號", draws.at(-1)?.id || "—"],
    ["最新日期", draws.at(-1)?.date || "—"]
  ].map(([a, b]) =>
    `<div class="stat"><span>${a}</span><b>${b}</b></div>`
  ).join("");

  const f = Array(50).fill(0);

  draws.forEach(d =>
    d.nums.forEach(x => f[x]++)
  );

  const max = Math.max(1, ...f);

  $("freq").innerHTML = f.slice(1).map((v, i) =>
    `<div class="fcell">
      <b>${i + 1}</b>${v}
      <div class="bar" style="width:${100 * v / max}%"></div>
    </div>`
  ).join("");

  $("backtest").textContent = backtest(draws);
}

// ----------------------------------------
// Walk-forward backtest
// ----------------------------------------

function backtest(h) {

  if (h.length < 31) {
    return `目前 ${h.length} 期；至少需要 31 期才顯示回測。`;
  }

  let total = 0;
  let hit = 0;
  let random = 0;

  for (let i = Math.max(20, h.length - 120); i < h.length; i++) {

    const past = h.slice(0, i);
    const actual = h[i].nums;

    const best = generatePicks(past, 700);

    if (!best.length) continue;

    total++;

    hit += Math.max(
      ...best.map(p =>
        p.nums.filter(n => actual.includes(n)).length
      )
    );

    let rh = 0;

    for (let j = 0; j < 5; j++) {

      const a = [];

      while (a.length < 6) {

        const x = 1 + Math.floor(Math.random() * 49);

        if (!a.includes(x)) a.push(x);
      }

      rh = Math.max(
        rh,
        a.filter(x => actual.includes(x)).length
      );
    }

    random += rh;
  }

  return (
    `最近 ${total} 期 walk-forward：` +
    `模型五組中每期最高命中數平均 ` +
    `${(hit / Math.max(1, total)).toFixed(2)}；` +
    `隨機五組基準 ` +
    `${(random / Math.max(1, total)).toFixed(2)}。` +
    `這是歷史樣本比較，不能推斷未來優勢。`
  );
}

// ----------------------------------------
// CSV import
// ----------------------------------------

function parseCSV(text) {

  const lines = text
    .replace(/^\uFEFF/, "")
    .trim()
    .split(/\r?\n/);

  if (lines.length < 2) {
    throw Error("CSV 沒有資料列");
  }

  const split = line =>
    line.split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/)
      .map(s => s.trim().replace(/^"|"$/g, ""));

  const headers = split(lines[0]).map(x => x.toLowerCase());

  const find = (names, idx) => {

    for (const name of names) {

      const i = headers.indexOf(name);

      if (i >= 0) return i;
    }

    return idx;
  };

  const idI = find(
    ["draw_id", "drawid", "期號", "期數"],
    0
  );

  const dateI = find(
    ["date", "draw_date", "drawdate", "開獎日期", "日期"],
    1
  );

  const numI = [1, 2, 3, 4, 5, 6].map(n =>
    find([
      `n${n}`,
      `num${n}`,
      `number${n}`,
      `ball_${n}`,
      `號碼${n}`,
      `中獎號碼${n}`
    ], 1 + n)
  );

  return lines.slice(1).map((line, i) => {

    const c = split(line);
    const nums = numI.map(j => Number(c[j]));

    return {
      id: c[idI] || `CSV-${i}-${c[dateI]}`,
      date: normalDate(c[dateI]),
      nums
    };

  }).filter(r => valid(r.nums) && r.date);
}

function normalDate(v) {

  if (!v) return null;

  const m = String(v).match(
    /(\d{4})[-/](\d{1,2})[-/](\d{1,2})/
  );

  return m
    ? `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`
    : null;
}

$("csvFile").onchange = async e => {

  const file = e.target.files[0];

  if (!file) return;

  try {

    const rows = parseCSV(await file.text());

    const payload = rows.map(r => ({
      user_id: user.id,
      draw_id: r.id,
      draw_date: r.date,
      n1: r.nums[0],
      n2: r.nums[1],
      n3: r.nums[2],
      n4: r.nums[3],
      n5: r.nums[4],
      n6: r.nums[5],
      extra: null,
      source: "CSV import"
    }));

    const { data: oldRows, error: oldRowsError } = await sb.from("draws").select("draw_id,lifecycle_state,n1,n2,n3,n4,n5,n6,extra").eq("user_id", user.id).in("draw_id", payload.map(r => r.draw_id));
    if (oldRowsError) throw oldRowsError;
    const oldByDrawId = new Map((oldRows || []).map(d => [d.draw_id, d]));
    const changedDrawIds = [];
    payload.forEach(row => {
      const old = oldByDrawId.get(row.draw_id);
      const sameNumbers = old && ["n1", "n2", "n3", "n4", "n5", "n6"].every(key => Number(old[key]) === row[key]);
      row.extra = old?.extra ?? null;
      row.lifecycle_state = sameNumbers && old.lifecycle_state !== "PRE_DRAW" ? old.lifecycle_state : "NUMBERS_ONLY";
      if (old && !sameNumbers) changedDrawIds.push(row.draw_id);
    });

    const { error } = await sb
      .from("draws")
      .upsert(payload, {
        onConflict: "user_id,draw_id"
      });

    if (error) throw error;

    if (changedDrawIds.length) {
      const { error: marketStateError } = await sb.from("draw_market_data").update({ lifecycle_state: "NUMBERS_ONLY" }).eq("user_id", user.id).in("draw_id", changedDrawIds);
      if (marketStateError) throw marketStateError;
    }

    await loadDraws();
    await generate({ forceFull: true, reason: "historical_csv_import" });

    render();

    msg(
      `匯入完成：${rows.length} 期；已合併重複期號。`
    );

  } catch (err) {

    msg("CSV 匯入失敗：" + err.message);

  }

  e.target.value = "";
};

// ----------------------------------------
// CSV export
// ----------------------------------------

$("export").onclick = () => {

  const rows = [
    ["draw_id", "date", "n1", "n2", "n3", "n4", "n5", "n6"],
    ...draws.map(d => [d.id, d.date, ...d.nums])
  ];

  const csv =
    "\uFEFF" +
    rows.map(r => r.join(",")).join("\n");

  const a = document.createElement("a");

  a.href = URL.createObjectURL(
    new Blob([csv], {
      type: "text/csv;charset=utf-8"
    })
  );

  a.download = "marksix-history.csv";
  a.click();

  URL.revokeObjectURL(a.href);
};

})();

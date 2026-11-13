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
    nums: [
      d.n1, d.n2, d.n3,
      d.n4, d.n5, d.n6
    ].map(Number)
  })).filter(d => valid(d.nums));

  $("dbInfo").textContent =
    `雲端歷史：${draws.length.toLocaleString()} 期` +
    (draws.length
      ? ` · 最近 ${draws.at(-1).date}`
      : "");
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

      if (payload.length) {

        const { error: e } = await sb
          .from("draws")
          .upsert(payload, {
            onConflict: "user_id,draw_id"
          });

        if (e) throw e;
      }
    }

    await loadDraws();
    await generate();
    render();

    msg(
      `同步完成：HKJC 回傳 ${rows.length} 期；` +
      `雲端共 ${draws.length} 期。`
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

  await generate();
  render();

  msg("已重新分析並儲存推薦結果。");
};

// ----------------------------------------
// Number scoring model
// ----------------------------------------

function scoreSet(set, history) {

  const flat = history.flatMap(d => d.nums);

  const freq = Array(50).fill(0);
  const recent = Array(50).fill(0);
  const gap = Array(50).fill(history.length);

  flat.forEach(n => freq[n]++);

  history.slice(-50).forEach(d =>
    d.nums.forEach(n => recent[n]++)
  );

  for (let i = history.length - 1; i >= 0; i--) {

    for (const n of history[i].nums) {

      if (gap[n] === history.length) {
        gap[n] = history.length - 1 - i;
      }
    }
  }

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

function generatePicks(history, candidateCount = 7000) {

  if (history.length < 10) return [];

  const candidates = [];

  for (let k = 0; k < candidateCount; k++) {

    const a = [];

    while (a.length < 6) {

      const n = 1 + Math.floor(Math.random() * 49);

      if (!a.includes(n)) a.push(n);
    }

    a.sort((x, y) => x - y);

    candidates.push({
      nums: a,
      score: scoreSet(a, history)
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

async function generate() {

  picks = generatePicks(draws);

  if (!user || !picks.length) return;

  const { error } = await sb
    .from("recommendations")
    .insert({
      user_id: user.id,
      as_of_draw: draws.at(-1)?.id || null,
      combinations: picks.map(p => p.nums),
      model_version: "weighted-v1"
    });

  if (error) {
    msg("推薦已計算，但雲端儲存失敗：" + error.message);
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
          ? `<small class="muted">模型分數 ${p.score.toFixed(2)}</small>`
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
      source: "CSV import"
    }));

    const { error } = await sb
      .from("draws")
      .upsert(payload, {
        onConflict: "user_id,draw_id"
      });

    if (error) throw error;

    await loadDraws();
    await generate();

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

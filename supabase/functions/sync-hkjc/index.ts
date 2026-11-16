// HKJC GraphQL sync. Public draw numbers and officially published market data
// are stored separately; an unpublished field remains null.
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-sync-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const endpoint = "https://info.cld.hkjc.com/graphql/base/";
// Live date-range checks confirmed HKJC currently serves historical records
// from 1993 onward; tested ranges in 1975, 1976, and 1992 were empty.
const FIRST_DRAW_YEAR = 1993;
function defaultPublishableKey() {
  const named = Deno.env.get("SUPABASE_PUBLISHABLE_KEYS");
  if (named) {
    const key = JSON.parse(named)?.default;
    if (key) return key;
  }
  const legacy = Deno.env.get("SUPABASE_ANON_KEY");
  if (!legacy) throw new Error("Supabase publishable key is unavailable in Edge Function environment");
  return legacy;
}
function defaultSecretKey() {
  const named = Deno.env.get("SUPABASE_SECRET_KEYS");
  if (named) {
    const key = JSON.parse(named)?.default;
    if (key) return key;
  }
  const legacy = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!legacy) throw new Error("Supabase server secret key is unavailable in Edge Function environment");
  return legacy;
}
const query = `fragment lotteryDrawsFragment on LotteryDraw {
 id year no openDate closeDate drawDate status snowballCode snowballName_en snowballName_ch
 lotteryPool { sell status totalInvestment jackpot unitBet estimatedPrize derivedFirstPrizeDiv lotteryPrizes { type winningUnit dividend } }
 drawResult { drawnNo xDrawnNo }
}
query marksixResult($lastNDraw: Int, $startDate: String, $endDate: String, $drawType: LotteryDrawType) {
 lotteryDraws(lastNDraw:$lastNDraw startDate:$startDate endDate:$endDate drawType:$drawType) { ...lotteryDrawsFragment }
}`;

const nullableNumber = (value: unknown): number | null => {
  const cleaned = typeof value === "string" ? value.replace(/[,$\s]/g, "").replace(/^HK/i, "") : value;
  const n = typeof cleaned === "number" ? cleaned : Number(cleaned);
  return value === null || value === undefined || value === "" || !Number.isFinite(n) || n < 0 ? null : n;
};

function hkParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en", { timeZone: "Asia/Hong_Kong", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date);
  return Object.fromEntries(parts.map((p) => [p.type, Number(p.value)])) as Record<string, number>;
}
function dateString(year: number, month = 1, day = 1) {
  return `${year}${String(month).padStart(2, "0")}${String(day).padStart(2, "0")}`;
}
function dateOffsetHK(days: number): string {
  const p = hkParts();
  const shifted = new Date(Date.UTC(p.year, p.month - 1, p.day + days));
  return dateString(shifted.getUTCFullYear(), shifted.getUTCMonth() + 1, shifted.getUTCDate());
}

function normalizeDraw(d: any) {
  const rawNumbers = d?.drawResult?.drawnNo || [];
  const numbers = rawNumbers.map((x: any) => Number(typeof x === "object" ? (x.no ?? x.number ?? x.value) : x))
    .filter((n: number) => Number.isInteger(n) && n >= 1 && n <= 49).slice(0, 6);
  const extraRaw = d?.drawResult?.xDrawnNo;
  const extraNumber = Number(typeof extraRaw === "object" ? (extraRaw.no ?? extraRaw.number ?? extraRaw.value) : extraRaw);
  const dateRaw = d?.drawDate || d?.closeDate || d?.openDate || "";
  const dateMatch = String(dateRaw).match(/(\d{4})-(\d{2})-(\d{2})/);
  const pool = d?.lotteryPool || {};
  const prizes = Array.isArray(pool.lotteryPrizes) ? pool.lotteryPrizes.map((p: any) => ({
    type: p?.type == null ? null : String(p.type),
    winningUnit: nullableNumber(p?.winningUnit),
    dividend: nullableNumber(p?.dividend),
  })).filter((p: any) => p.type !== null) : [];
  return {
    id: String(d?.id ?? `${d?.year}/${d?.no}`),
    date: dateMatch ? `${dateMatch[1]}-${dateMatch[2]}-${dateMatch[3]}` : null,
    numbers,
    extra: Number.isInteger(extraNumber) && extraNumber >= 1 && extraNumber <= 49 ? extraNumber : null,
    status: d?.status == null ? null : String(d.status),
    poolStatus: pool?.status == null ? null : String(pool.status),
    poolSell: typeof pool?.sell === "boolean" ? pool.sell : null,
    totalInvestment: nullableNumber(pool.totalInvestment),
    jackpot: nullableNumber(pool.jackpot),
    unitBet: nullableNumber(pool.unitBet),
    estimatedPrize: nullableNumber(pool.estimatedPrize),
    firstPrizeDividend: nullableNumber(pool.derivedFirstPrizeDiv),
    snowballCode: d?.snowballCode == null ? null : String(d.snowballCode),
    snowballName: d?.snowballName_ch ?? d?.snowballName_en ?? null,
    prizes,
  };
}

async function fetchDraws(variables: Record<string, unknown>) {
  let lastError: unknown;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Accept": "application/json", "Origin": "https://bet.hkjc.com", "User-Agent": "Mozilla/5.0 MarkSix-PWA/3.0" },
        body: JSON.stringify({ operationName: "marksixResult", variables: { drawType: "All", ...variables }, query }),
        signal: AbortSignal.timeout(20000),
      });
      if (!response.ok) {
        const error = new Error(`HKJC HTTP ${response.status}`) as Error & { retryable?: boolean };
        error.retryable = response.status === 429 || response.status >= 500;
        throw error;
      }
      const json = await response.json();
      if (json.errors?.length) throw new Error(json.errors.map((e: any) => e.message).join("; "));
      const draws = json?.data?.lotteryDraws;
      if (!Array.isArray(draws)) throw new Error("HKJC response did not contain a draw list");
      return draws;
    } catch (error) {
      lastError = error;
      const retryable = error instanceof TypeError || ["TimeoutError", "AbortError"].includes((error as any)?.name) || (error as any)?.retryable === true;
      if (!retryable || attempt === 3) break;
      await new Promise((resolve) => setTimeout(resolve, 350 * (2 ** attempt) + Math.random() * 200));
    }
  }
  throw new Error(`HKJC request failed after retries: ${String(lastError)}`);
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      out[index] = await fn(items[index]);
    }
  });
  await Promise.all(workers);
  return out;
}

function validHistoricalDraw(d: any) {
  return d.date && d.numbers.length === 6 && new Set(d.numbers).size === 6;
}
function mergeDraws(rows: any[]) {
  const byId = new Map<string, any>();
  for (const row of rows) {
    const old = byId.get(row.id);
    if (!old) { byId.set(row.id, row); continue; }
    byId.set(row.id, {
      ...old,
      ...Object.fromEntries(Object.entries(row).filter(([, value]) => value != null && value !== "")),
      numbers: row.numbers.length === 6 ? row.numbers : old.numbers,
      prizes: row.prizes.length ? row.prizes : old.prizes,
    });
  }
  return [...byId.values()].filter(validHistoricalDraw).sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
}

async function fetchHistory(fullBackfill: boolean) {
  const today = hkParts();
  const latest = fetchDraws({ lastNDraw: 50 });
  let ranges: Array<{ startDate: string; endDate: string }>;
  if (fullBackfill) {
    ranges = [];
    for (let year = FIRST_DRAW_YEAR; year <= today.year; year++) {
      for (const month of [1, 4, 7, 10]) {
        const quarterEnd = new Date(Date.UTC(year, month + 2, 0));
        let endYear = quarterEnd.getUTCFullYear(), endMonth = quarterEnd.getUTCMonth() + 1, endDay = quarterEnd.getUTCDate();
        if (endYear > today.year || (endYear === today.year && (endMonth > today.month || (endMonth === today.month && endDay > today.day)))) {
          endYear = today.year; endMonth = today.month; endDay = today.day;
        }
        if (year > today.year || (year === today.year && month > today.month)) continue;
        ranges.push({ startDate: dateString(year, month, 1), endDate: dateString(endYear, endMonth, endDay) });
      }
    }
  } else {
    const start = new Date(Date.UTC(today.year, today.month - 1, today.day - 90));
    ranges = [{ startDate: dateString(start.getUTCFullYear(), start.getUTCMonth() + 1, start.getUTCDate()), endDate: dateOffsetHK(0) }];
  }
  // Quarter ranges keep under common result caps; suspiciously full responses
  // are split into month requests instead of silently accepting a truncated page.
  const batches = await mapLimit(ranges, 8, async (range) => {
    const result = await fetchDraws(range);
    const startYear = Number(range.startDate.slice(0, 4)), startMonth = Number(range.startDate.slice(4, 6));
    const endYear = Number(range.endDate.slice(0, 4)), endMonth = Number(range.endDate.slice(4, 6));
    if (result.length >= 45 && startYear === endYear && endMonth - startMonth >= 2) {
      const months = [0, 1, 2].map((offset) => {
        const monthDate = new Date(Date.UTC(startYear, startMonth - 1 + offset, 1));
        const year = monthDate.getUTCFullYear(), month = monthDate.getUTCMonth() + 1;
        const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
        const end = range.endDate.slice(0, 6) === dateString(year, month).slice(0, 6) ? Number(range.endDate.slice(6, 8)) : lastDay;
        return { startDate: dateString(year, month, 1), endDate: dateString(year, month, end) };
      });
      return (await Promise.all(months.map((monthRange) => fetchDraws(monthRange)))).flat();
    }
    return result;
  });
  const [latestRows] = await Promise.all([latest]);
  return mergeDraws([...batches.flat(), ...latestRows.map(normalizeDraw)]);
}

function officialMarketRow(userId: string, draw: any, old: any, observedAt: string) {
  const incoming = new Map((draw.prizes || []).map((p: any) => [String(p.type), p]));
  const previous = new Map((Array.isArray(old?.prize_data) ? old.prize_data : []).map((p: any) => [String(p.type), p]));
  const keys = new Set([...previous.keys(), ...incoming.keys()]);
  const prizes = [...keys].map((key) => {
    const before: any = previous.get(key) || {};
    const after: any = incoming.get(key) || {};
    return { ...before, ...after, winningUnit: after.winningUnit ?? before.winningUnit ?? null, dividend: after.dividend ?? before.dividend ?? null };
  });
  const divisionOf = (value: unknown) => {
    const text = String(value ?? "").toLowerCase();
    const numeric = text.match(/(?:^|\D)([1-7])(?:\D|$)/);
    if (numeric) return Number(numeric[1]);
    return ({ first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7 } as Record<string, number>)[text] ?? null;
  };
  const byDivision = new Map(prizes.map((p: any) => [divisionOf(p.type), p]));
  const pick = (n: number, key: string) => byDivision.get(n)?.[key] ?? null;
  const sales = draw.totalInvestment ?? old?.actual_sales ?? null;
  const jackpot = draw.jackpot ?? old?.official_jackpot ?? null;
  const complete = prizes.length >= 7 && prizes.every((p: any) => p.winningUnit != null && p.dividend != null);
  const source = { source: "HKJC public GraphQL", observed_at: observedAt };
  const fieldSources: Record<string, unknown> = { ...(old?.field_sources || {}), official_sync: source };
  for (const [field, value] of Object.entries({ actual_sales: draw.totalInvestment, official_jackpot: draw.jackpot, unit_bet: draw.unitBet, estimated_prize: draw.estimatedPrize, prize_data: draw.prizes.length ? draw.prizes : null })) if (value != null) fieldSources[field] = source;
  const row = {
    ...(old || {}), user_id: userId, draw_id: draw.id,
    lifecycle_state: complete ? "PRIZE_DATA_READY" : "NUMBERS_ONLY",
    actual_sales: sales, official_jackpot: jackpot, snowball_amount: old?.snowball_amount ?? null,
    snowball_code: draw.snowballCode ?? old?.snowball_code ?? null,
    snowball_name: draw.snowballName ?? old?.snowball_name ?? null,
    unit_bet: draw.unitBet ?? old?.unit_bet ?? null,
    pool_status: draw.poolStatus ?? old?.pool_status ?? null,
    pool_sell: draw.poolSell ?? old?.pool_sell ?? null,
    estimated_prize: draw.estimatedPrize ?? old?.estimated_prize ?? null,
    first_prize_dividend: pick(1, "dividend") ?? draw.firstPrizeDividend ?? old?.first_prize_dividend ?? null,
    second_prize_dividend: pick(2, "dividend") ?? old?.second_prize_dividend ?? null,
    third_prize_dividend: pick(3, "dividend") ?? old?.third_prize_dividend ?? null,
    first_prize_winning_units: pick(1, "winningUnit") ?? old?.first_prize_winning_units ?? null,
    second_prize_winning_units: pick(2, "winningUnit") ?? old?.second_prize_winning_units ?? null,
    third_prize_winning_units: pick(3, "winningUnit") ?? old?.third_prize_winning_units ?? null,
    prize_data: prizes.length ? prizes : (old?.prize_data ?? null),
    field_sources: fieldSources, data_version: Number(old?.data_version || 0) + 1,
    updated_at: observedAt, last_error: null,
  };
  const officialFields = ["actual_sales", "official_jackpot", "unit_bet", "estimated_prize", "first_prize_dividend", "second_prize_dividend", "third_prize_dividend", "first_prize_winning_units", "second_prize_winning_units", "third_prize_winning_units", "prize_data", "pool_status", "pool_sell", "snowball_code", "snowball_name"];
  const changed = !old || officialFields.some((key) => JSON.stringify(old[key] ?? null) !== JSON.stringify(row[key] ?? null));
  if (!changed) return null;
  return row;
}

async function persistForUser(client: any, userId: string, draws: any[], observedAt: string, fullBackfill: boolean) {
  const { data: oldSync, error: oldSyncError } = await client.from("draw_sync_status").select("oldest_date,latest_date,initial_backfill_complete").eq("user_id", userId).maybeSingle();
  if (oldSyncError) throw oldSyncError;
  const byState: Record<string, string[]> = { NUMBERS_ONLY: [], PRIZE_DATA_READY: [], MODEL_UPDATED: [] };
  for (let offset = 0; offset < draws.length; offset += 400) {
    const part = draws.slice(offset, offset + 400);
    const ids = part.map((d) => d.id);
    const [{ data: existingDraws, error: drawReadError }, { data: markets, error: marketReadError }] = await Promise.all([
      client.from("draws").select("draw_id,lifecycle_state").eq("user_id", userId).in("draw_id", ids),
      client.from("draw_market_data").select("*").eq("user_id", userId).in("draw_id", ids),
    ]);
    if (drawReadError) throw drawReadError;
    if (marketReadError) throw marketReadError;
    const stateById = new Map((existingDraws || []).map((d: any) => [d.draw_id, d.lifecycle_state]));
    const oldMarketById = new Map((markets || []).map((d: any) => [d.draw_id, d]));
    const drawRows = part.map((d) => {
      const oldState = stateById.get(d.id);
      return { user_id: userId, draw_id: d.id, draw_date: d.date, n1: d.numbers[0], n2: d.numbers[1], n3: d.numbers[2], n4: d.numbers[3], n5: d.numbers[4], n6: d.numbers[5], extra: d.extra, source: "HKJC GraphQL", lifecycle_state: oldState && oldState !== "PRE_DRAW" ? oldState : "NUMBERS_ONLY" };
    });
    const { error: drawWriteError } = await client.from("draws").upsert(drawRows, { onConflict: "user_id,draw_id" });
    if (drawWriteError) throw drawWriteError;
    const marketRows = part.map((d) => officialMarketRow(userId, d, oldMarketById.get(d.id), observedAt)).filter(Boolean);
    if (marketRows.length) {
      const { error: marketWriteError } = await client.from("draw_market_data").upsert(marketRows, { onConflict: "user_id,draw_id" });
      if (marketWriteError) throw marketWriteError;
      for (const row of marketRows) if (byState[row.lifecycle_state]) byState[row.lifecycle_state].push(row.draw_id);
    }
  }
  for (const state of Object.keys(byState)) {
    const ids = byState[state];
    for (let i = 0; i < ids.length; i += 400) {
      const { error } = await client.from("draws").update({ lifecycle_state: state }).eq("user_id", userId).in("draw_id", ids.slice(i, i + 400));
      if (error) throw error;
    }
  }
  const [countResult, oldestResult, latestResult] = await Promise.all([
    client.from("draws").select("draw_id", { count: "exact", head: true }).eq("user_id", userId).neq("lifecycle_state", "PRE_DRAW"),
    client.from("draws").select("draw_date").eq("user_id", userId).neq("lifecycle_state", "PRE_DRAW").order("draw_date", { ascending: true }).limit(1).maybeSingle(),
    client.from("draws").select("draw_date").eq("user_id", userId).neq("lifecycle_state", "PRE_DRAW").order("draw_date", { ascending: false }).limit(1).maybeSingle(),
  ]);
  if (countResult.error) throw countResult.error;
  if (oldestResult.error) throw oldestResult.error;
  if (latestResult.error) throw latestResult.error;
  const status = { user_id: userId, status: "COMPLETED", source: "HKJC public GraphQL", draw_count: countResult.count ?? draws.length, oldest_date: oldestResult.data?.draw_date || oldSync?.oldest_date || draws[0]?.date || null, latest_date: latestResult.data?.draw_date || oldSync?.latest_date || draws.at(-1)?.date || null, initial_backfill_complete: fullBackfill || oldSync?.initial_backfill_complete === true, last_error: null, synced_at: observedAt };
  const { error: statusError } = await client.from("draw_sync_status").upsert(status, { onConflict: "user_id" });
  if (statusError) throw statusError;
}

async function runScheduledSync() {
  const serviceKey = defaultSecretKey();
  const admin = createClient(Deno.env.get("SUPABASE_URL")!, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const accounts: any[] = [];
  for (let page = 1; ; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 500 });
    if (error) throw error;
    accounts.push(...data.users);
    if (data.users.length < 500) break;
  }
  const { data: statusRows, error: statusError } = await admin.from("draw_sync_status").select("user_id,initial_backfill_complete");
  if (statusError) throw statusError;
  const statusByUser = new Map((statusRows || []).map((row: any) => [row.user_id, row.initial_backfill_complete]));
  const needsBackfill = accounts.some((account) => statusByUser.get(account.id) !== true);
  const observedAt = new Date().toISOString();
  for (const account of accounts) {
    const { error } = await admin.from("draw_sync_status").upsert({ user_id: account.id, status: "RUNNING", last_error: null, updated_at: observedAt }, { onConflict: "user_id" });
    if (error) throw error;
  }
  let draws: any[];
  try {
    draws = await fetchHistory(needsBackfill);
    if (!draws.length) throw new Error("HKJC returned no historical draw records; sync status was not marked complete");
  } catch (error) {
    for (const account of accounts) await admin.from("draw_sync_status").upsert({ user_id: account.id, status: "FAILED", last_error: String(error), updated_at: new Date().toISOString() }, { onConflict: "user_id" });
    throw error;
  }
  let syncedUsers = 0;
  for (let i = 0; i < accounts.length; i++) {
    const account = accounts[i];
    try {
      await persistForUser(admin, account.id, draws, observedAt, needsBackfill);
    } catch (error) {
      for (const pending of accounts.slice(i)) await admin.from("draw_sync_status").upsert({ user_id: pending.id, status: "FAILED", last_error: String(error), updated_at: new Date().toISOString() }, { onConflict: "user_id" });
      throw error;
    }
    syncedUsers++;
  }
  return { ok: true, mode: needsBackfill ? "initial_backfill" : "incremental", drawCount: draws.length, syncedUsers, observedAt };
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const cronSecret = Deno.env.get("SYNC_CRON_SECRET");
    const suppliedSecret = req.headers.get("x-sync-secret") || "";
    const bearer = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
    const isScheduled = Boolean(cronSecret && suppliedSecret && suppliedSecret === cronSecret && bearer === cronSecret);
    if (isScheduled) {
      const result = await runScheduledSync();
      return new Response(JSON.stringify(result), { headers: { ...cors, "Content-Type": "application/json" } });
    }

    const auth = req.headers.get("Authorization") || "";
    const supabase = createClient(Deno.env.get("SUPABASE_URL")!, defaultPublishableKey(), { global: { headers: { Authorization: auth } } });
    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: { ...cors, "Content-Type": "application/json" } });
    const { data: syncStatus, error: statusError } = await supabase.from("draw_sync_status").select("initial_backfill_complete").eq("user_id", user.id).maybeSingle();
    if (statusError) throw statusError;
    const fullBackfill = !syncStatus?.initial_backfill_complete;
    const [draws, upcomingRaw] = await Promise.all([
      fetchHistory(fullBackfill),
      fetchDraws({ startDate: dateOffsetHK(0), endDate: dateOffsetHK(14) }).catch(() => []),
    ]);
    if (!draws.length) throw new Error("HKJC returned no historical draw records; sync status was not marked complete");
    const historicalIds = new Set(draws.map((d) => d.id));
    const todayHK = `${dateOffsetHK(0).slice(0, 4)}-${dateOffsetHK(0).slice(4, 6)}-${dateOffsetHK(0).slice(6, 8)}`;
    const preDraws = upcomingRaw.map(normalizeDraw).filter((d: any) => !historicalIds.has(d.id) && d.numbers.length === 0 && d.date && d.date >= todayHK);
    return new Response(JSON.stringify({ draws, preDraws, source: "HKJC public GraphQL", observedAt: new Date().toISOString(), count: draws.length, preDrawCount: preDraws.length, fullBackfill, coverageStart: draws[0]?.date ?? null, coverageEnd: draws.at(-1)?.date ?? null, snowballAmount: null, snowballAmountNote: "No verified numeric Snowball Pool amount field is published by the queried interface." }), { headers: { ...cors, "Content-Type": "application/json" } });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), { status: 502, headers: { ...cors, "Content-Type": "application/json" } });
  }
});

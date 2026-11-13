// HKJC GraphQL proxy for published draw, pool and prize data.
// The GraphQL endpoint is public but undocumented and may change.
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const endpoint = "https://info.cld.hkjc.com/graphql/base/";
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

function dateOffsetHK(days: number): string {
  const parts = new Intl.DateTimeFormat("en", { timeZone: "Asia/Hong_Kong", year: "numeric", month: "2-digit", day: "2-digit" })
    .formatToParts(new Date());
  const part = (name: string) => Number(parts.find(p => p.type === name)?.value);
  const shifted = new Date(Date.UTC(part("year"), part("month") - 1, part("day") + days));
  return `${shifted.getUTCFullYear()}${String(shifted.getUTCMonth() + 1).padStart(2, "0")}${String(shifted.getUTCDate()).padStart(2, "0")}`;
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
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Accept": "application/json", "Origin": "https://bet.hkjc.com", "User-Agent": "Mozilla/5.0 MarkSix-PWA/2.0" },
    body: JSON.stringify({ operationName: "marksixResult", variables: { drawType: "All", ...variables }, query }),
    signal: AbortSignal.timeout(25000),
  });
  if (!response.ok) throw new Error(`HKJC HTTP ${response.status}`);
  const json = await response.json();
  if (json.errors?.length) throw new Error(json.errors.map((e: any) => e.message).join("; "));
  return json?.data?.lotteryDraws || [];
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const auth = req.headers.get("Authorization") || "";
    const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, { global: { headers: { Authorization: auth } } });
    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: { ...cors, "Content-Type": "application/json" } });

    const observedAt = new Date().toISOString();
    const [historicalRaw, upcomingResult] = await Promise.all([
      fetchDraws({ lastNDraw: 50 }),
      fetchDraws({ startDate: dateOffsetHK(0), endDate: dateOffsetHK(14) }).then(data => ({ data, error: null })).catch(error => ({ data: [], error: String(error) })),
    ]);
    const historical = historicalRaw.map(normalizeDraw).filter((d: any) => d.date && d.numbers.length === 6 && new Set(d.numbers).size === 6);
    const historicalIds = new Set(historical.map((d: any) => d.id));
    const todayHK = `${dateOffsetHK(0).slice(0, 4)}-${dateOffsetHK(0).slice(4, 6)}-${dateOffsetHK(0).slice(6, 8)}`;
    const preDraws = upcomingResult.data.map(normalizeDraw).filter((d: any) => !historicalIds.has(d.id) && d.numbers.length === 0 && d.date && d.date >= todayHK);
    return new Response(JSON.stringify({
      draws: historical,
      preDraws,
      source: "HKJC public GraphQL",
      observedAt,
      count: historical.length,
      preDrawCount: preDraws.length,
      preDrawWarning: upcomingResult.error,
      snowballAmount: null,
      snowballAmountNote: "The current query exposes snowball code/name but no verified numeric Snowball Pool amount field.",
    }), { headers: { ...cors, "Content-Type": "application/json" } });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), { status: 502, headers: { ...cors, "Content-Type": "application/json" } });
  }
});

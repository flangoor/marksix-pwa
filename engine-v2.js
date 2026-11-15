/* Quantitative Engine v2 core. Pure functions; no secrets or network access. */
(() => {
  "use strict";
  // Bump this version whenever scoring weights, features, or calibration semantics change.
  const MODEL_VERSION = "quant-v2-core-1";
  const DRAW_OUTCOMES = 13983816; // C(49, 6)
  const DIVISION_PROBABILITY = { 1: 1 / DRAW_OUTCOMES, 2: 6 / DRAW_OUTCOMES, 3: 252 / DRAW_OUTCOMES };
  const choose = (n, k) => {
    if (!Number.isInteger(n) || !Number.isInteger(k) || k < 0 || k > n) return 0;
    let x = 1;
    for (let i = 1; i <= k; i++) x = x * (n - k + i) / i;
    return Math.round(x);
  };
  const validDraw = a => Array.isArray(a) && a.length === 6 && a.every(n => Number.isInteger(n) && n >= 1 && n <= 49) && new Set(a).size === 6;

  function fullFeatures(draws) {
    const frequency = Array(50).fill(0), gap = Array(50).fill(draws.length), recent = [];
    for (let i = 0; i < draws.length; i++) {
      if (!validDraw(draws[i].nums)) continue;
      const nums = [...draws[i].nums];
      recent.push(nums);
      nums.forEach(n => { frequency[n]++; gap[n] = 0; });
      if (recent.length > 50) recent.shift();
    }
    // The newest draw has gap 0; unseen numbers count the full history length.
    for (let n = 1; n <= 49; n++) {
      if (!frequency[n]) gap[n] = draws.length;
      else {
        let found = false;
        for (let i = draws.length - 1; i >= 0; i--) {
          if (draws[i].nums?.includes(n)) { gap[n] = draws.length - 1 - i; found = true; break; }
        }
        if (!found) gap[n] = draws.length;
      }
    }
    return { drawCount: draws.length, frequency, gap, recent, throughDrawId: draws.at(-1)?.id ?? null };
  }

  function addDraw(features, draw) {
    if (!validDraw(draw.nums)) throw new Error("Invalid six-number draw");
    const next = structuredClone(features);
    next.drawCount++;
    next.throughDrawId = draw.id ?? null;
    for (let n = 1; n <= 49; n++) next.gap[n]++;
    draw.nums.forEach(n => { next.frequency[n]++; next.gap[n] = 0; });
    next.recent.push([...draw.nums]);
    if (next.recent.length > 50) next.recent.shift();
    return next;
  }

  function lifecycleState({ numbersReady, prizeData }) {
    if (!numbersReady) return "PRE_DRAW";
    if (!Array.isArray(prizeData) || prizeData.length === 0 || prizeData.some(p => p.dividend == null || p.winningUnit == null)) return "NUMBERS_ONLY";
    return "PRIZE_DATA_READY";
  }

  // Computes an explicit model estimate. It cannot call a pre-draw estimate positive
  // unless the caller supplies a calibrated uncertainty interval and all prize tiers.
  function preDrawGate({ ticketCost, jackpot, estimatedSales, payoutSampleCount = 0 }) {
    const fail = (reason, extra = {}) => ({ decision: "INSUFFICIENT DATA", reason, ev: null, netEv: null, roi: null, model: "historical-poisson", ...extra });
    if (![ticketCost, jackpot, estimatedSales].every(Number.isFinite) || ticketCost <= 0 || jackpot < 0 || estimatedSales < 0) return fail("請輸入有效金額；每注成本須大於零。");
    if (payoutSampleCount < 30) return fail(`有效歷史派彩樣本只有 ${payoutSampleCount} 期；至少需要 30 期。`, { payoutSampleCount });
    const N = estimatedSales / ticketCost;
    const denominator = DRAW_OUTCOMES;
    const probs = {
      1: 1 / denominator,
      2: 6 / denominator,
      3: 252 / denominator,
      4: choose(6,4) * choose(43,2) / denominator,
      5: choose(6,3) * choose(1,1) * choose(42,2) / denominator,
      6: choose(6,3) * choose(42,3) / denominator,
      7: choose(6,2) * choose(1,1) * choose(42,3) / denominator
    };
    const fixed = {4:9600,5:640,6:320,7:40};
    const fixedExpected = [4,5,6,7].reduce((sum,d)=>sum+N*probs[d]*fixed[d],0);
    const variablePool = Math.max(0, estimatedSales * 0.5 - fixedExpected);
    const shares = {1:0.45,2:0.15,3:0.40};
    const evaluate = crowd => {
      const top = [1,2,3].reduce((sum,d) => {
        const lambda = Math.max(0, N * probs[d] * crowd);
        const shareFactor = lambda === 0 ? 1 : -Math.expm1(-lambda) / lambda;
        const pool = d === 1 ? jackpot + variablePool * shares[d] : variablePool * shares[d];
        return sum + probs[d] * pool * shareFactor;
      },0);
      const lower = [4,5,6,7].reduce((sum,d)=>sum+probs[d]*fixed[d],0);
      return { expectedReturn: top + lower, top, lower };
    };
    const low = evaluate(1.3), mid = evaluate(1), high = evaluate(0.7);
    const expectedNetEV = mid.expectedReturn-ticketCost;
    const evLow = low.expectedReturn-ticketCost, evHigh = high.expectedReturn-ticketCost;
    const risk = (1 - (N*probs[1] === 0 ? 1 : -Math.expm1(-N*probs[1])/(N*probs[1]))) * 100;
    return {
      decision: evLow > 0 ? "POSITIVE EV ESTIMATE" : evHigh < 0 ? "SKIP" : "UNCERTAIN",
      reason: "按歷史資料門檻、官方固定獎金及泊松分獎敏感度估算；非保證回報。",
      expectedReturn: mid.expectedReturn, ev: mid.expectedReturn, netEv: expectedNetEV, expectedNetEV,
      roi: expectedNetEV/ticketCost, jackpotShareRiskPercent: risk, headPrizeDilutionRiskPercent: risk,
      confidenceInterval90: { low: evLow, high: evHigh }, evLow, evHigh,
      fixedReturnPerTicket: fixedExpected/N, estimatedTickets: N, payoutSampleCount, model: "historical-poisson"
    };
  }

  // Greedy maximum coverage: cover t-subsets of the mother pool with six-number tickets.
  function fullWheel(pool, { ticketCost = 10, budget = 0, t = 5, m = 6 } = {}) {
    const p=[...new Set(pool)].sort((a,b)=>a-b);
    if(p.length<6||p.length>18||p.some(n=>!Number.isInteger(n)||n<1||n>49)) throw new Error("母池需包含 6 至 18 個不重複的 1–49 號碼。");
    if(!Number.isInteger(t)||t<1||t>6||!Number.isInteger(m)||m<t||m>p.length) throw new Error("目標條件須為有效 t、m（1 ≤ t ≤ 6，t ≤ m ≤ 母池數量）。");
    if(!Number.isFinite(ticketCost)||ticketCost<=0||!Number.isFinite(budget)||budget<0) throw new Error("請輸入有效每注成本及預算。");
    const limit=Math.floor(budget/ticketCost);
    const subsets=[];
    function gen(start,row){if(row.length===m){subsets.push([...row]);return;}for(let i=start;i<=p.length-(m-row.length);i++){row.push(p[i]);gen(i+1,row);row.pop();}}
    gen(0,[]);
    const covered=new Set(), tickets=[];
    const combinations=[];
    function comb(start,row){if(row.length===6){combinations.push([...row]);return;}for(let i=start;i<=p.length-(6-row.length);i++){row.push(p[i]);comb(i+1,row);row.pop();}}
    comb(0,[]);
    const ticketCovers=combinations.map(ticket=>subsets.map((s,i)=>s.filter(n=>ticket.includes(n)).length>=t?i:-1).filter(i=>i>=0));
    while(tickets.length<limit&&covered.size<subsets.length){
      let best=-1,bestGain=0;
      for(let i=0;i<combinations.length;i++){if(tickets.some(x=>x.join(",")===combinations[i].join(",")))continue;let gain=0;for(const key of ticketCovers[i])if(!covered.has(key))gain++;if(gain>bestGain){best=i;bestGain=gain;}}
      if(best<0||bestGain===0)break;
      tickets.push(combinations[best]);for(const key of ticketCovers[best])covered.add(key);
    }
    const total=subsets.length;
    return {tickets,poolSize:p.length,ticketCount:tickets.length,coveredOutcomes:covered.size,totalPoolOutcomes:total,coverageWithinPool:total?covered.size/total:0,ticketCost,budget,totalCost:tickets.length*ticketCost,withinBudget:true,t,m,guarantee:`Greedy 覆蓋 ${m} 號子集中的 ${t} 號子集；不代表開獎概率或全中保證。`};
  }

  function crowdFeatureKey(sorted) {
    const birthdayHeavy = sorted.filter(n => n <= 31).length >= 4;
    const hasConsecutive = sorted.slice(1).some((n, i) => n - sorted[i] === 1);
    return `${birthdayHeavy ? "birthday-heavy" : "mixed"}:${hasConsecutive ? "consecutive" : "no-consecutive"}`;
  }

  // Proxy labels compare official winner units with Poisson expected units derived
  // from sales/unit stake and the exact division probabilities for a single line.
  function buildCrowdProxyModel(records) {
    let payoutSampleCount = 0; const groups = new Map(), totalByDivision = { 1: { observed: 0, expected: 0 }, 2: { observed: 0, expected: 0 }, 3: { observed: 0, expected: 0 } }, allDrawIds = new Set();
    for (const row of records || []) {
      if (!validDraw(row.nums) || !(row.sales > 0) || !(row.unitBet > 0)) continue;
      const prizes = Array.isArray(row.prizes) ? row.prizes : [];
      const tierRows = new Map(prizes.map(p => { const v=String(p.type??"").toLowerCase(); const m=v.match(/(?:^|\\D)([1-7])(?:\\D|$)/); return [m?Number(m[1]):null,p]; }));
      if ([1,2,3,4,5,6,7].every(d => tierRows.get(d)?.winningUnit != null && tierRows.get(d)?.dividend != null)) payoutSampleCount++;
      const byDivision = new Map();
      for (const p of prizes) {
        const value = String(p.type ?? "").toLowerCase();
        const m = value.match(/(?:^|\D)([123])(?:\D|$)/);
        const wordMap = value.includes("first") ? 1 : value.includes("second") ? 2 : value.includes("third") ? 3 : null;
        const division = m ? Number(m[1]) : wordMap;
        if (division && p.winningUnit != null) byDivision.set(division, Number(p.winningUnit));
      }
      // Exclude the whole draw if a first/second/third winning-unit field is
      // missing: an unpublished NULL must never be mistaken for zero winners.
      if (![1, 2, 3].every(d => byDivision.has(d))) continue;
      const key = crowdFeatureKey([...row.nums].sort((a, b) => a - b));
      for (const division of [1, 2, 3]) {
        if (!byDivision.has(division)) continue;
        const expected = (row.sales / row.unitBet) * DIVISION_PROBABILITY[division];
        if (!(expected > 0)) continue;
        if (!groups.has(key)) groups.set(key, { byDivision: { 1: { observed: 0, expected: 0, drawIds: new Set() }, 2: { observed: 0, expected: 0, drawIds: new Set() }, 3: { observed: 0, expected: 0, drawIds: new Set() } } });
        const group = groups.get(key);
        const observation = group.byDivision[division];
        const actual = byDivision.get(division);
        const drawId = row.id ?? row.draw_id ?? `${row.date}:${row.nums.join("-")}`;
        observation.observed += actual;
        observation.expected += expected;
        observation.drawIds.add(drawId);
        totalByDivision[division].observed += actual;
        totalByDivision[division].expected += expected;
        allDrawIds.add(drawId);
      }
    }
    const priorStrength = 10;
    const globalRateByDivision = Object.fromEntries([1, 2, 3].map(d => [d, (totalByDivision[d].observed + priorStrength) / (totalByDivision[d].expected + priorStrength)]));
    const globalRate = [1, 2, 3].reduce((sum, d) => sum + DIVISION_PROBABILITY[d] * globalRateByDivision[d], 0) / [1, 2, 3].reduce((sum, d) => sum + DIVISION_PROBABILITY[d], 0);
    const serialGroups = Object.fromEntries([...groups].map(([key, value]) => [key, {
      byDivision: Object.fromEntries([1, 2, 3].map(d => [d, { observed: value.byDivision[d].observed, expected: value.byDivision[d].expected, draws: value.byDivision[d].drawIds.size }]))
    }]));
    return { groups: serialGroups, globalRate, globalRateByDivision, observationCount: allDrawIds.size, payoutSampleCount, label: "actual winning units / Poisson expected units from official turnover, by division 1–3" };
  }

  // No player-pick dataset exists. This proxy is an empirical historical payout-dilution estimate.
  function crowdProxy(nums, model = null) {
    const sorted = [...nums].sort((a, b) => a - b);
    if (sorted.length !== 6 || new Set(sorted).size !== 6 || sorted.some(n => n < 1 || n > 49)) throw new Error("需要六個不重複的 1–49 號碼。");
    const birthdayShare = sorted.filter(n => n <= 31).length / 6;
    const consecutivePairs = sorted.slice(1).filter((n, i) => n - sorted[i] === 1).length;
    const arithmeticRuns = [3, 4, 5].filter(step => sorted.slice(1).every((n, i) => n - sorted[i] === step)).length;
    const structuralScore = birthdayShare * 0.5 + consecutivePairs * 0.15 + arithmeticRuns * 0.3;
    const group = model?.groups?.[crowdFeatureKey(sorted)];
    const divisionMultipliers = model?.globalRateByDivision ? Object.fromEntries([1, 2, 3].map(d => {
      const local = group?.byDivision?.[d];
      const prior = model.globalRateByDivision[d];
      return [d, local ? (local.observed + 10 * prior) / (local.expected + 10) : prior];
    })) : null;
    const totalProbability = [1, 2, 3].reduce((sum, d) => sum + DIVISION_PROBABILITY[d], 0);
    const predictedMultiplier = divisionMultipliers ? [1, 2, 3].reduce((sum, d) => sum + DIVISION_PROBABILITY[d] * divisionMultipliers[d], 0) / totalProbability : null;
    const sampleDraws = group ? Math.max(...[1, 2, 3].map(d => group.byDivision[d].draws)) : (model?.observationCount ?? 0);
    return {
      birthdayShare, consecutivePairs, arithmeticRuns,
      riskScore: predictedMultiplier == null ? structuralScore : predictedMultiplier - 1,
      predictedMultiplier,
      sampleDraws,
      status: model?.observationCount ? "PROXY_ESTIMATE" : "STRUCTURE_ONLY",
      note: model?.observationCount ? "基於歷史派彩分薄程度之代理估計（Proxy Estimate）；由實際中獎單位與理論泊松預期注數比較，不代表真實投注分布或中獎概率。" : "未有足夠歷史派彩資料；只顯示組合結構代理，不代表真實投注分布。"
    };
  }

  window.MarkSixEngineV2 = { MODEL_VERSION, DRAW_OUTCOMES, choose, fullFeatures, addDraw, lifecycleState, preDrawGate, fullWheel, buildCrowdProxyModel, crowdProxy };
})();

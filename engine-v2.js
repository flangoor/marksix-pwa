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
  function preDrawGate({ ticketCost, jackpot, estimatedSales, tiers, confidenceInterval, calibrationId }) {
    const fail = reason => ({ decision: "UNCERTAIN", reason, ev: null, roi: null, model: "estimate" });
    if (!Number.isFinite(ticketCost) || !(ticketCost > 0) || !Number.isFinite(jackpot) || !(jackpot >= 0) || !Number.isFinite(estimatedSales) || !(estimatedSales >= 0)) return fail("需要有效的每注成本、金多寶及預估投注額。");
    if (!Array.isArray(tiers) || tiers.length !== 7 || tiers.some(t => !Number.isFinite(t.probability) || !(t.probability >= 0 && t.probability <= 1) || !Number.isFinite(t.expectedPayout) || !(t.expectedPayout >= 0))) return fail("需要完整七個獎級的有效預估派彩模型。");
    if (!calibrationId) return fail("派彩估算模型尚未提供校準版本。");
    const pSum = tiers.reduce((s, t) => s + t.probability, 0);
    if (pSum > 1 + 1e-10) return fail("獎級機率總和超過 1，模型設定無效。");
    const lambda = Math.max(0, estimatedSales / ticketCost - 1) / DRAW_OUTCOMES;
    const jackpotShare = lambda === 0 ? jackpot : jackpot * (-Math.expm1(-lambda)) / lambda;
    const ev = tiers.reduce((s, t) => s + t.probability * t.expectedPayout, 0) + tiers[0].probability * jackpotShare;
    const netEv = ev - ticketCost;
    const roi = netEv / ticketCost;
    if (!confidenceInterval || !Number.isFinite(confidenceInterval.low) || !Number.isFinite(confidenceInterval.high) || confidenceInterval.low > confidenceInterval.high) return { decision: "UNCERTAIN", reason: "欠缺校準模型的不確定區間；不作正 EV 判定。", ev, netEv, roi, jackpotShare, model: "estimate", calibrationId };
    const decision = confidenceInterval.low > 0 ? "POSITIVE EV ESTIMATE" : confidenceInterval.high < 0 ? "SKIP" : "UNCERTAIN";
    return { decision, reason: "估值只代表模型估算，不保證未來回報。", ev, netEv, roi, jackpotShare, model: "estimate", calibrationId };
  }

  // Full wheel for a mother pool: every six-number result wholly inside the pool
  // is explicitly covered. Refuse huge inputs rather than imply uncomputed coverage.
  function fullWheel(pool, { ticketCost = null, budget = null } = {}) {
    const p = [...new Set(pool)].sort((a, b) => a - b);
    if (p.length < 6 || p.length > 18 || p.some(n => !Number.isInteger(n) || n < 1 || n > 49)) throw new Error("母池需包含 6 至 18 個不重複的 1–49 號碼。");
    if ((ticketCost !== null && (!Number.isFinite(ticketCost) || ticketCost <= 0)) || (budget !== null && (!Number.isFinite(budget) || budget < 0))) throw new Error("每注成本必須大於零，預算必須是零或正數。");
    if (budget !== null && ticketCost === null) throw new Error("要核對預算，請同時輸入每注成本。");
    const tickets = [];
    function visit(start, row) {
      if (row.length === 6) { tickets.push([...row]); return; }
      for (let i = start; i <= p.length - (6 - row.length); i++) { row.push(p[i]); visit(i + 1, row); row.pop(); }
    }
    visit(0, []);
    const coveredOutcomes = choose(p.length, 6);
    const totalCost = ticketCost == null ? null : tickets.length * ticketCost;
    return { tickets, poolSize: p.length, ticketCount: tickets.length, coveredOutcomes, totalPoolOutcomes: coveredOutcomes, coverageWithinPool: 1, ticketCost, budget, totalCost, withinBudget: budget == null || totalCost == null ? null : totalCost <= budget, guarantee: "只保證開出六個號碼全部落在母池內時有一注全中；母池外不作保證。" };
  }

  function crowdFeatureKey(sorted) {
    const birthdayHeavy = sorted.filter(n => n <= 31).length >= 4;
    const hasConsecutive = sorted.slice(1).some((n, i) => n - sorted[i] === 1);
    return `${birthdayHeavy ? "birthday-heavy" : "mixed"}:${hasConsecutive ? "consecutive" : "no-consecutive"}`;
  }

  // Proxy labels compare official winner units with Poisson expected units derived
  // from sales/unit stake and the exact division probabilities for a single line.
  function buildCrowdProxyModel(records) {
    const groups = new Map(), totalByDivision = { 1: { observed: 0, expected: 0 }, 2: { observed: 0, expected: 0 }, 3: { observed: 0, expected: 0 } }, allDrawIds = new Set();
    for (const row of records || []) {
      if (!validDraw(row.nums) || !(row.sales > 0) || !(row.unitBet > 0)) continue;
      const prizes = Array.isArray(row.prizes) ? row.prizes : [];
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
    return { groups: serialGroups, globalRate, globalRateByDivision, observationCount: allDrawIds.size, label: "actual winning units / Poisson expected units from official turnover, by division 1–3" };
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
      riskScore: predictedMultiplier ?? structuralScore,
      predictedMultiplier,
      sampleDraws,
      status: model?.observationCount ? "PROXY_ESTIMATE" : "STRUCTURE_ONLY",
      note: model?.observationCount ? "基於歷史派彩分薄程度之代理估計（Proxy Estimate）；由實際中獎單位與理論泊松預期注數比較，不代表真實投注分布或中獎概率。" : "未有足夠歷史派彩資料；只顯示組合結構代理，不代表真實投注分布。"
    };
  }

  window.MarkSixEngineV2 = { MODEL_VERSION, DRAW_OUTCOMES, choose, fullFeatures, addDraw, lifecycleState, preDrawGate, fullWheel, buildCrowdProxyModel, crowdProxy };
})();

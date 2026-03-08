#!/usr/bin/env node

import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const DEFAULT_BASE_URL = "https://summit-production-69ed.up.railway.app";
const DEFAULT_START = "2026-02-19T00:00:00Z";
const DEFAULT_BUCKET_MIN = 60;

function parseArgs(argv) {
  const opts = {
    baseUrl: DEFAULT_BASE_URL,
    startDate: DEFAULT_START,
    bucketMin: DEFAULT_BUCKET_MIN,
    outputJsonl: "./assets/data/global-stats-backfill.jsonl",
    outputJs: "./assets/data/global-stats-backfill.js",
    limit: 200,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--base-url") {
      opts.baseUrl = argv[i + 1] || opts.baseUrl;
      i += 1;
      continue;
    }
    if (arg === "--start-date") {
      opts.startDate = argv[i + 1] || opts.startDate;
      i += 1;
      continue;
    }
    if (arg === "--bucket-min") {
      const parsed = Number(argv[i + 1]);
      if (Number.isFinite(parsed) && parsed > 0) opts.bucketMin = parsed;
      i += 1;
      continue;
    }
    if (arg === "--output-jsonl") {
      opts.outputJsonl = argv[i + 1] || opts.outputJsonl;
      i += 1;
      continue;
    }
    if (arg === "--output-js") {
      opts.outputJs = argv[i + 1] || opts.outputJs;
      i += 1;
      continue;
    }
    if (arg === "--page-limit") {
      const parsed = Number(argv[i + 1]);
      if (Number.isFinite(parsed) && parsed > 0) opts.limit = Math.floor(parsed);
      i += 1;
      continue;
    }
  }

  return opts;
}

function toNumber(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

async function fetchJsonWithRetry(url, retries = 8, timeoutMs = 20_000) {
  let lastError = null;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, { signal: controller.signal });
      clearTimeout(timer);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${await response.text()}`);
      }
      return await response.json();
    } catch (error) {
      clearTimeout(timer);
      lastError = error;
      if (attempt < retries) {
        const delayMs = 500 * (attempt + 1);
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }
  throw lastError;
}

async function fetchCurrentSupply(baseUrl) {
  return await fetchJsonWithRetry(`${baseUrl}/consumables/supply`);
}

async function fetchAllLogsForCategory(baseUrl, category, limit) {
  const encodedCategory = encodeURIComponent(category);
  const first = await fetchJsonWithRetry(`${baseUrl}/logs?category=${encodedCategory}&limit=${limit}&offset=0`);
  const total = Math.max(0, toNumber(first?.pagination?.total));
  const out = [...(first?.data || [])];

  console.log(`${category} logs total=${total}`);
  for (let offset = limit; offset < total; offset += limit) {
    if (offset % (limit * 20) === 0) {
      console.log(`  fetched ${category} logs offset=${offset}/${total}`);
    }
    const page = await fetchJsonWithRetry(
      `${baseUrl}/logs?category=${encodedCategory}&limit=${limit}&offset=${offset}`,
    );
    out.push(...(page?.data || []));
  }

  return out;
}

function toSpendPoints(logs, startMs) {
  const points = [];
  for (const row of logs) {
    const createdAt = row?.created_at;
    if (!createdAt) continue;
    const tsMs = Date.parse(createdAt);
    if (!Number.isFinite(tsMs) || tsMs < startMs) continue;

    const data = row?.data || {};
    const sub = row?.sub_category || "";
    const attack = sub === "BattleEvent" ? toNumber(data.attack_potions) : 0;
    const revive = sub === "BattleEvent" ? toNumber(data.revive_potions) : 0;
    const xlife = sub === "Applied Extra Life" ? Math.max(0, toNumber(data.difference)) : 0;
    const poison = sub === "Applied Poison" ? Math.max(0, toNumber(data.count)) : 0;

    if (attack === 0 && revive === 0 && xlife === 0 && poison === 0) continue;
    points.push({ tsMs, attack, revive, xlife, poison });
  }

  points.sort((a, b) => a.tsMs - b.tsMs);
  return points;
}

function toBuyPoints(logs, startMs) {
  const points = [];
  for (const row of logs) {
    if (row?.sub_category !== "Bought Potions") continue;
    const createdAt = row?.created_at;
    if (!createdAt) continue;
    const tsMs = Date.parse(createdAt);
    if (!Number.isFinite(tsMs) || tsMs < startMs) continue;

    const data = row?.data || {};
    const token = String(data.token || "").toUpperCase();
    const amount = Math.max(0, toNumber(data.amount));
    if (amount <= 0) continue;

    const entry = { tsMs, attack: 0, revive: 0, xlife: 0, poison: 0 };
    if (token === "ATTACK") entry.attack = amount;
    else if (token === "REVIVE") entry.revive = amount;
    else if (token === "POISON") entry.poison = amount;
    else if (token === "EXTRA LIFE") entry.xlife = amount;
    else continue;

    points.push(entry);
  }

  points.sort((a, b) => a.tsMs - b.tsMs);
  return points;
}

function buildSnapshots(spendPoints, buyPoints, currentSupply, startMs, bucketMin) {
  const nowMs = Date.now();
  const stepMs = Math.max(1, bucketMin) * 60_000;

  const totalSpent = spendPoints.reduce(
    (acc, p) => {
      acc.attack += p.attack;
      acc.revive += p.revive;
      acc.xlife += p.xlife;
      acc.poison += p.poison;
      return acc;
    },
    { attack: 0, revive: 0, xlife: 0, poison: 0 },
  );

  const totalBought = buyPoints.reduce(
    (acc, p) => {
      acc.attack += p.attack;
      acc.revive += p.revive;
      acc.xlife += p.xlife;
      acc.poison += p.poison;
      return acc;
    },
    { attack: 0, revive: 0, xlife: 0, poison: 0 },
  );

  const initialSupply = {
    attack: toNumber(currentSupply.attack) + totalSpent.attack - totalBought.attack,
    revive: toNumber(currentSupply.revive) + totalSpent.revive - totalBought.revive,
    xlife: toNumber(currentSupply.xlife) + totalSpent.xlife - totalBought.xlife,
    poison: toNumber(currentSupply.poison) + totalSpent.poison - totalBought.poison,
  };

  let spendIdx = 0;
  let buyIdx = 0;
  const spentSoFar = { attack: 0, revive: 0, xlife: 0, poison: 0 };
  const boughtSoFar = { attack: 0, revive: 0, xlife: 0, poison: 0 };
  const snapshots = [];

  for (let t = startMs; t <= nowMs; t += stepMs) {
    while (spendIdx < spendPoints.length && spendPoints[spendIdx].tsMs <= t) {
      const p = spendPoints[spendIdx];
      spentSoFar.attack += p.attack;
      spentSoFar.revive += p.revive;
      spentSoFar.xlife += p.xlife;
      spentSoFar.poison += p.poison;
      spendIdx += 1;
    }
    while (buyIdx < buyPoints.length && buyPoints[buyIdx].tsMs <= t) {
      const p = buyPoints[buyIdx];
      boughtSoFar.attack += p.attack;
      boughtSoFar.revive += p.revive;
      boughtSoFar.xlife += p.xlife;
      boughtSoFar.poison += p.poison;
      buyIdx += 1;
    }

    snapshots.push({
      timestamp: new Date(t).toISOString(),
      consumables: {
        attack: Math.max(0, initialSupply.attack - spentSoFar.attack + boughtSoFar.attack),
        revive: Math.max(0, initialSupply.revive - spentSoFar.revive + boughtSoFar.revive),
        xlife: Math.max(0, initialSupply.xlife - spentSoFar.xlife + boughtSoFar.xlife),
        poison: Math.max(0, initialSupply.poison - spentSoFar.poison + boughtSoFar.poison),
      },
    });
  }

  snapshots.push({
    timestamp: new Date(nowMs).toISOString(),
    consumables: {
      attack: toNumber(currentSupply.attack),
      revive: toNumber(currentSupply.revive),
      xlife: toNumber(currentSupply.xlife),
      poison: toNumber(currentSupply.poison),
    },
  });

  return snapshots;
}

async function writeOutputs(rows, outputJsonl, outputJs) {
  await mkdir(dirname(outputJsonl), { recursive: true });
  await mkdir(dirname(outputJs), { recursive: true });

  const jsonl = `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`;
  await writeFile(outputJsonl, jsonl, "utf8");

  const js = `window.VALKYR_POTION_HISTORY = ${JSON.stringify(rows, null, 2)};\n`;
  await writeFile(outputJs, js, "utf8");
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const startMs = Date.parse(opts.startDate);
  if (!Number.isFinite(startMs)) {
    throw new Error(`Invalid --start-date: ${opts.startDate}`);
  }

  console.log(`Updating potion history from ${new Date(startMs).toISOString()}...`);
  const [currentSupply, battleLogs, marketLogs] = await Promise.all([
    fetchCurrentSupply(opts.baseUrl),
    fetchAllLogsForCategory(opts.baseUrl, "Battle", opts.limit),
    fetchAllLogsForCategory(opts.baseUrl, "Market", opts.limit),
  ]);

  const spendPoints = toSpendPoints(battleLogs, startMs);
  const buyPoints = toBuyPoints(marketLogs, startMs);
  const rows = buildSnapshots(spendPoints, buyPoints, currentSupply, startMs, opts.bucketMin);
  await writeOutputs(rows, opts.outputJsonl, opts.outputJs);

  console.log(`Wrote ${rows.length} points`);
  console.log(`Range: ${rows[0]?.timestamp} -> ${rows[rows.length - 1]?.timestamp}`);
}

main().catch((error) => {
  console.error("update-potion-history failed:", error);
  process.exit(1);
});

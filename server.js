const express = require("express");
const path = require("path");

const app = express();
app.use(express.json({ limit: "32kb" }));
app.use(express.static(path.join(__dirname, "public")));

const PORT = Number(process.env.PORT || 10000);
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL || "";
const DEFAULT_INTERVAL_MINUTES = Math.max(5, Number(process.env.SCAN_INTERVAL_MINUTES || 15));
const MAX_PAGES_HARD_LIMIT = 10;

// This is a hobby prototype. Roblox may rate-limit requests or change these experimental endpoints.
let config = {
  maxPrice: 500,
  pages: 3,
  intervalMinutes: DEFAULT_INTERVAL_MINUTES,
  enabled: true
};
let state = {
  running: false,
  lastStartedAt: null,
  lastFinishedAt: null,
  lastError: "",
  itemsChecked: 0,
  deals: [],
  logs: [],
  notifiedIds: new Set()
};
let scanTimer = null;

function log(message) {
  state.logs.unshift({ at: new Date().toISOString(), message });
  state.logs = state.logs.slice(0, 30);
  console.log(`[Limited Radar] ${message}`);
}
function delay(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: {
      "Accept": "application/json",
      "User-Agent": "LimitedRadar/1.0 (personal hobby price tracker)"
    },
    signal: AbortSignal.timeout(15000)
  });
  if (!response.ok) {
    const error = new Error(`Roblox API returned HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return response.json();
}


async function getCatalogPage(cursor) {
  const url = new URL("https://catalog.roblox.com/v2/search/items/details");
  url.searchParams.set("categoryFilter", "Collectibles");
  url.searchParams.set("limit", "30");
  url.searchParams.set("sortType", "PriceLowToHigh");
  if (cursor) url.searchParams.set("cursor", cursor);
  return fetchJson(url.toString());
}


async function getLowestResale(assetId) {
  const url = `https://economy.roblox.com/v1/assets/${encodeURIComponent(assetId)}/resellers?limit=10&cursor=`;
  const data = await fetchJson(url);
  const prices = (Array.isArray(data.data) ? data.data : [])
    .map(item => Number(item.price))
    .filter(price => Number.isFinite(price) && price >= 0);
  return prices.length ? Math.min(...prices) : null;
}

async function sendDiscordAlert(deals) {
  if (!DISCORD_WEBHOOK_URL || !deals.length) return;
  // Keep each message small enough for Discord's content limit.
  const lines = deals.slice(0, 12).map(d =>
    `• **${String(d.name).replace(/[*_`~|>]/g, "")}** — **R$ ${d.price.toLocaleString()}** (asset ${d.id})\n  https://www.roblox.com/catalog/${d.id}/`
  );
  const extra = deals.length > 12 ? `\n…and ${deals.length - 12} more deals found.` : "";
  const body = {
    content: `🔔 **Limited Radar found ${deals.length} deal(s) at or below R$ ${config.maxPrice.toLocaleString()}**\n\n${lines.join("\n")}${extra}`
  };
  const response = await fetch(DISCORD_WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000)
  });
  if (!response.ok) throw new Error(`Discord webhook returned HTTP ${response.status}`);
}

async function runScan() {
  if (state.running) return { skipped: true, reason: "A scan is already running" };
  state.running = true;
  state.lastStartedAt = new Date().toISOString();
  state.lastError = "";
  state.itemsChecked = 0;
  const started = Date.now();
  const candidates = new Map();
  let cursor = "";
  let pagesRead = 0;
  let apiFailures = 0;
  try {
    for (let page = 0; page < Math.min(MAX_PAGES_HARD_LIMIT, config.pages); page++) {
      let result;
      try {
        result = await getCatalogPage(cursor);
      } catch (error) {
        apiFailures++;
        throw new Error(`Could not read Roblox catalog page ${page + 1}: ${error.message}`);
      }
      const items = Array.isArray(result.data) ? result.data : [];
      pagesRead++;
      for (const item of items) {
        const id = String(item.id || item.assetId || "");
        if (!/^\d+$/.test(id)) continue;
        candidates.set(id, { id, name: item.name || `Limited item ${id}` });
      }
      cursor = result.nextPageCursor || "";
      if (!cursor || !items.length) break;
      // Avoid hammering the public endpoint.
      await delay(500);
    }

    const found = [];
    const entries = [...candidates.values()];
    // Deliberately sequential and paced to reduce load and rate limiting.
    for (let i = 0; i < entries.length; i++) {
      const item = entries[i];
      try {
        const price = await getLowestResale(item.id);
        state.itemsChecked++;
        if (price !== null && price <= config.maxPrice) {
          found.push({ ...item, price, url: `https://www.roblox.com/catalog/${item.id}/` });
        }
     
} catch (error) {
  apiFailures++;
  log(`Reseller lookup failed for ${item.id}: ${error.message}`);
  if (error.status === 429) {
    log("Roblox rate-limited reseller lookups. Ending this scan early.");
    break;
  }
}

      if (i < entries.length - 1) await delay(350);
    }

    found.sort((a, b) => a.price - b.price);
    state.deals = found;
    // Notify only newly discovered deals; re-arm an item when it no longer appears in results.
    const currentIds = new Set(found.map(d => d.id));
    const fresh = found.filter(d => !state.notifiedIds.has(d.id));
    for (const id of [...state.notifiedIds]) if (!currentIds.has(id)) state.notifiedIds.delete(id);
    fresh.forEach(d => state.notifiedIds.add(d.id));
    if (fresh.length && DISCORD_WEBHOOK_URL) {
      try { await sendDiscordAlert(fresh); log(`Sent ${fresh.length} new deal(s) to Discord.`); }
      catch (error) { log(`Discord notification failed: ${error.message}`); }
    }
    log(`Scan finished: ${pagesRead} catalog page(s), ${state.itemsChecked} reseller checks, ${found.length} deal(s), ${apiFailures} API error(s), ${Date.now() - started} ms.`);
    return { ok: true, pagesRead, itemsChecked: state.itemsChecked, dealCount: found.length, apiFailures };
  } catch (error) {
    state.lastError = error.message;
    log(error.message);
    return { ok: false, error: error.message };
  } finally {
    state.running = false;
    state.lastFinishedAt = new Date().toISOString();
  }
}

function resetTimer() {
  if (scanTimer) clearInterval(scanTimer);
  scanTimer = null;
  if (config.enabled && config.intervalMinutes > 0) {
    scanTimer = setInterval(() => {
      runScan().catch(error => log(`Scheduled scan failed: ${error.message}`));
    }, config.intervalMinutes * 60 * 1000);
  }
}

app.get("/api/status", (req, res) => {
  res.json({
    config,
    running: state.running,
    lastStartedAt: state.lastStartedAt,
    lastFinishedAt: state.lastFinishedAt,
    lastError: state.lastError,
    itemsChecked: state.itemsChecked,
    deals: state.deals,
    logs: state.logs,
    discordConfigured: Boolean(DISCORD_WEBHOOK_URL)
  });
});

app.post("/api/config", (req, res) => {
  const maxPrice = Number(req.body.maxPrice);
  const pages = Number(req.body.pages);
  const intervalMinutes = Number(req.body.intervalMinutes);
  const enabled = Boolean(req.body.enabled);
  if (!Number.isFinite(maxPrice) || maxPrice < 1 || maxPrice > 100000000) {
    return res.status(400).json({ error: "Maximum price must be between 1 and 100,000,000 Robux." });
  }
  if (!Number.isInteger(pages) || pages < 1 || pages > MAX_PAGES_HARD_LIMIT) {
    return res.status(400).json({ error: `Pages must be between 1 and ${MAX_PAGES_HARD_LIMIT}.` });
  }
  if (!Number.isFinite(intervalMinutes) || intervalMinutes !== 0 && (intervalMinutes < 5 || intervalMinutes > 1440)) {
    return res.status(400).json({ error: "Use manual-only (0) or an interval between 5 and 1440 minutes." });
  }
  config = { maxPrice, pages, intervalMinutes, enabled: enabled && intervalMinutes > 0 };
  resetTimer();
  log(`Settings updated: target R$ ${maxPrice}, ${pages} page(s), interval ${intervalMinutes || "manual"} minute(s).`);
  res.json({ ok: true, config });
});

app.post("/api/scan", async (req, res) => {
  const result = await runScan();
  res.status(result.skipped ? 409 : result.ok ? 200 : 502).json(result);
});

app.get("/health", (req, res) => res.json({ ok: true, service: "limited-radar" }));

app.listen(PORT, "0.0.0.0", () => {
  log(`Server listening on port ${PORT}. Discord webhook ${DISCORD_WEBHOOK_URL ? "configured" : "not configured"}.`);
  resetTimer();
});

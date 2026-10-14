const express = require("express");
const path = require("path");

const app = express();
app.use(express.json({ limit: "32kb" }));
app.use(express.static(path.join(__dirname, "public")));

const PORT = Number(process.env.PORT || 10000);
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL || "";
const DEFAULT_INTERVAL_MINUTES = clampNumber(
  Number(process.env.SCAN_INTERVAL_MINUTES || 15), 5, 1440, 15
);
const ROLIMONS_ITEMS_URL = "https://api.rolimons.com/items/v2/itemdetails";
const ROLIMONS_THUMBS_URL = "https://api.rolimons.com/itemthumbs/v1/thumbssm";

// Cache item data so manual refreshes do not repeatedly hit Rolimons.
const ITEMS_CACHE_MS = 70_000;
const THUMBS_CACHE_MS = 10 * 60_000;
const MAX_LOGS = 30;

function clampNumber(value, min, max, fallback) {
  return Number.isFinite(value)
    ? Math.min(max, Math.max(min, value))
    : fallback;
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

let config = {
  maxPrice: 500,
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
let itemCache = { items: [], fetchedAt: 0 };
let thumbsCache = { items: {}, fetchedAt: 0 };
let itemFetchPromise = null;
let thumbsFetchPromise = null;
let itemRetryAfter = 0;
let lastItemFetchError = "";

function log(message) {
  state.logs.unshift({
    at: new Date().toISOString(),
    message: String(message)
  });

  state.logs = state.logs.slice(0, MAX_LOGS);
  console.log(`[Limited Radar] ${message}`);
}

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
      "User-Agent": "LimitedRadar/1.0 (personal hobby price tracker)",
      Referer: "https://www.rolimons.com/"
    },
    signal: AbortSignal.timeout(15000)
  });

  if (!response.ok) {
    const error = new Error(
      `Rolimons API returned HTTP ${response.status}`
    );
    error.status = response.status;
    throw error;
  }

  return response.json();
}

function safeHttpUrl(value) {
  try {
    const parsed = new URL(String(value));

    return parsed.protocol === "https:" || parsed.protocol === "http:"
      ? parsed.toString()
      : "";
  } catch {
    return "";
  }
}

async function getThumbnails() {
  if (
    thumbsCache.fetchedAt &&
    Date.now() - thumbsCache.fetchedAt < THUMBS_CACHE_MS
  ) {
    return thumbsCache.items;
  }

  if (thumbsFetchPromise) return thumbsFetchPromise;

  thumbsFetchPromise = (async () => {
    try {
      const data = await fetchJson(ROLIMONS_THUMBS_URL);

      const raw =
        data.items ||
        data.item_thumbs ||
        data.thumbnails ||
        {};

      const normalized = {};

      if (raw && typeof raw === "object") {
        for (const [id, url] of Object.entries(raw)) {
          const safeUrl = safeHttpUrl(url);

          if (/^\d+$/.test(id) && safeUrl) {
            normalized[id] = safeUrl;
          }
        }
      }

      thumbsCache = {
        items: normalized,
        fetchedAt: Date.now()
      };

      log(
        `Loaded ${Object.keys(normalized).length.toLocaleString()} Rolimons item thumbnails.`
      );

      return normalized;
    } catch (error) {
      log(`Could not load Rolimons thumbnails: ${error.message}`);

      thumbsCache = {
        items: {},
        fetchedAt: Date.now()
      };

      return {};
    } finally {
      thumbsFetchPromise = null;
    }
  })();

  return thumbsFetchPromise;
}

const DEMAND_LABELS = {
  "-1": "Unknown",
  0: "Terrible",
  1: "Low",
  2: "Normal",
  3: "High",
  4: "Amazing"
};

const TREND_LABELS = {
  "-1": "Unknown",
  0: "Lowering",
  1: "Unstable",
  2: "Stable",
  3: "Raising",
  4: "Fluctuating"
};

function usableNumber(value) {
  const number = Number(value);

  return Number.isFinite(number) && number >= 0
    ? number
    : null;
}

async function getRolimonsItems() {
  const now = Date.now();

  if (
    itemCache.items.length &&
    now - itemCache.fetchedAt < ITEMS_CACHE_MS
  ) {
    return itemCache;
  }

  if (now < itemRetryAfter) {
    if (itemCache.items.length) return itemCache;

    throw new Error(
      lastItemFetchError ||
      "Rolimons item data is temporarily cooling down after a failed request. Please retry in about a minute."
    );
  }

  if (itemFetchPromise) return itemFetchPromise;

  itemFetchPromise = (async () => {
    try {
      const data = await fetchJson(ROLIMONS_ITEMS_URL);

      if (!data || !data.items || typeof data.items !== "object") {
        throw new Error(
          "Unexpected response format from Rolimons item details."
        );
      }

      const thumbs = await getThumbnails();

      const items = Object.entries(data.items)
        .map(([id, row]) => {
          if (!/^\d+$/.test(id) || !Array.isArray(row)) {
            return null;
          }

          const rap = usableNumber(row[2]);
          const rawValue = usableNumber(row[3]);
          const value =
            rawValue !== null && rawValue > 0
              ? rawValue
              : null;

          return {
            id,
            name: String(row[0] || `Limited item ${id}`),
            acronym: String(row[1] || ""),
            rap,
            value,
            defaultValue: usableNumber(row[4]),
            demandCode: Number.isFinite(Number(row[5]))
              ? Number(row[5])
              : -1,
            trendCode: Number.isFinite(Number(row[6]))
              ? Number(row[6])
              : -1,
            projected: Number(row[7]) === 1,
            hyped: Number(row[8]) === 1,
            rare: Number(row[9]) === 1,
            demand:
              DEMAND_LABELS[String(Number(row[5]))] ||
              "Unknown",
            trend:
              TREND_LABELS[String(Number(row[6]))] ||
              "Unknown",
            image:
              thumbs[id] ||
              `https://www.roblox.com/asset-thumbnail/image?assetId=${id}&width=150&height=150&format=png`,
            url: `https://www.roblox.com/catalog/${id}/`,
            rolimonsUrl: `https://www.rolimons.com/item/${id}`
          };
        })
        .filter(Boolean);

      itemCache = {
        items,
        fetchedAt: Date.now()
      };

      itemRetryAfter = 0;
      lastItemFetchError = "";

      log(
        `Loaded ${items.length.toLocaleString()} items from Rolimons.`
      );

      return itemCache;
    } catch (error) {
      itemRetryAfter = Date.now() + ITEMS_CACHE_MS;

      lastItemFetchError =
        `${error.message}. The server will wait before retrying to respect Rolimons rate limits.`;

      if (itemCache.items.length) {
        log(
          `Rolimons refresh failed (${error.message}); continuing with cached data and delaying the next retry.`
        );

        return itemCache;
      }

      throw new Error(lastItemFetchError);
    } finally {
      itemFetchPromise = null;
    }
  })();

  return itemFetchPromise;
}

function underRapLimit(items) {
  return items
    .filter(
      item =>
        item.rap !== null &&
        item.rap <= config.maxPrice
    )
    .sort((a, b) => a.rap - b.rap);
}

async function sendDiscordAlert(items) {
  if (!DISCORD_WEBHOOK_URL || !items.length) return;

  const lines = items.slice(0, 12).map(item =>
    `• **${String(item.name).replace(/[*_\`~|>]/g, "")}** — RAP **R$ ${Number(item.rap).toLocaleString()}**` +
    (
      item.value !== null
        ? ` · Rolimons value **R$ ${Number(item.value).toLocaleString()}**`
        : ""
    ) +
    `\n  ${item.rolimonsUrl}`
  );

  const extra =
    items.length > 12
      ? `\n…and ${items.length - 12} more items.`
      : "";

  const body = {
    content:
      `📡 **Limited Radar: ${items.length} item(s) with RAP at or below R$ ${config.maxPrice.toLocaleString()}**\n` +
      `This is a RAP filter, not a live reseller-price deal alert.\n\n` +
      `${lines.join("\n")}${extra}`
  };

  const response = await fetch(DISCORD_WEBHOOK_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000)
  });

  if (!response.ok) {
    throw new Error(
      `Discord webhook returned HTTP ${response.status}`
    );
  }
}

async function runScan() {
  if (state.running) {
    return {
      skipped: true,
      reason: "A scan is already running"
    };
  }

  state.running = true;
  state.lastStartedAt = new Date().toISOString();
  state.lastError = "";

  const started = Date.now();

  try {
    const catalog = await getRolimonsItems();

    state.itemsChecked = catalog.items.length;

    const matches = underRapLimit(catalog.items);
    state.deals = matches;

    const currentIds = new Set(
      matches.map(item => item.id)
    );

    const fresh = matches.filter(
      item => !state.notifiedIds.has(item.id)
    );

    for (const id of [...state.notifiedIds]) {
      if (!currentIds.has(id)) {
        state.notifiedIds.delete(id);
      }
    }

    fresh.forEach(item => state.notifiedIds.add(item.id));

    if (fresh.length && DISCORD_WEBHOOK_URL) {
      try {
        await sendDiscordAlert(fresh);

        log(
          `Sent ${fresh.length} new RAP-threshold item alert(s) to Discord.`
        );
      } catch (error) {
        log(
          `Discord notification failed: ${error.message}`
        );
      }
    }

    log(
      `Rolimons scan finished: ${catalog.items.length.toLocaleString()} items loaded, ${matches.length.toLocaleString()} at or below RAP R$ ${config.maxPrice.toLocaleString()}, ${Date.now() - started} ms.`
    );

    return {
      ok: true,
      source: "Rolimons",
      itemsChecked: catalog.items.length,
      dealCount: matches.length,
      fetchedAt: new Date(catalog.fetchedAt).toISOString()
    };
  } catch (error) {
    state.lastError = error.message;
    log(error.message);

    return {
      ok: false,
      error: error.message
    };
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
      runScan().catch(error =>
        log(`Scheduled scan failed: ${error.message}`)
      );
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
    discordConfigured: Boolean(DISCORD_WEBHOOK_URL),
    source: "Rolimons",
    cachedItemsAt: itemCache.fetchedAt
      ? new Date(itemCache.fetchedAt).toISOString()
      : null
  });
});

app.get("/api/items", async (req, res) => {
  try {
    const catalog = await getRolimonsItems();

    res.set("Cache-Control", "public, max-age=30");

    res.json({
      source: "Rolimons",
      count: catalog.items.length,
      fetchedAt: new Date(catalog.fetchedAt).toISOString(),
      items: catalog.items
    });
  } catch (error) {
    res.status(502).json({
      error: `Could not load Rolimons item data: ${error.message}`
    });
  }
});

app.post("/api/config", (req, res) => {
  const maxPrice = Number(req.body.maxPrice);
  const intervalMinutes = Number(req.body.intervalMinutes);
  const enabled = Boolean(req.body.enabled);

  if (
    !Number.isFinite(maxPrice) ||
    maxPrice < 1 ||
    maxPrice > 100000000
  ) {
    return res.status(400).json({
      error: "Maximum RAP must be between 1 and 100,000,000 Robux."
    });
  }

  if (
    !Number.isFinite(intervalMinutes) ||
    (
      intervalMinutes !== 0 &&
      (intervalMinutes < 5 || intervalMinutes > 1440)
    )
  ) {
    return res.status(400).json({
      error: "Use manual-only (0) or an interval between 5 and 1440 minutes."
    });
  }

  config = {
    maxPrice,
    intervalMinutes,
    enabled: enabled && intervalMinutes > 0
  };

  resetTimer();

  log(
    `Settings updated: RAP threshold R$ ${maxPrice.toLocaleString()}, interval ${intervalMinutes || "manual"} minute(s).`
  );

  res.json({
    ok: true,
    config
  });
});

app.post("/api/scan", async (req, res) => {
  const result = await runScan();

  res
    .status(result.skipped ? 409 : result.ok ? 200 : 502)
    .json(result);
});

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    service: "limited-radar",
    source: "Rolimons"
  });
});

app.listen(PORT, "0.0.0.0", () => {
  log(
    `Server listening on port ${PORT}. Rolimons item data enabled. Discord webhook ${DISCORD_WEBHOOK_URL ? "configured" : "not configured"}.`
  );

  resetTimer();
});

// ============================================================================
// Statusio • Stremio Add-on (TV-Compatible v1.2.0 - Critical/Expired Only)
// Shows only when subscription is ≤3 days or expired
// ============================================================================

import sdk from "stremio-addon-sdk";
const { addonBuilder, serveHTTP } = sdk;
import fetch from "node-fetch";

// ----------------------------- Icon ----------------------------------------
const LOGO_URL =
  "https://raw.githubusercontent.com/ARandomAddonDev/Statusio/refs/heads/main/assets/logo.png";

// ----------------------------- Helpers -------------------------------------
const MIN = 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

const ceilDays = (ms) => Math.max(0, Math.ceil(ms / DAY_MS));
const redact = (tok) =>
  tok ? `${String(tok).slice(0, 4)}…${String(tok).slice(-4)}` : "(none)";
const isoDate = (iso) =>
  iso ? new Date(iso).toISOString().slice(0, 10) : "N/A";

function daysLeftFromEpochSec(epochSec) {
  const secs = Number(epochSec || 0);
  if (!Number.isFinite(secs) || secs <= 0) return { days: 0, untilISO: null };
  const ms = secs * 1000 - Date.now();
  if (ms <= 0) return { days: 0, untilISO: null };
  return { days: ceilDays(ms), untilISO: new Date(secs * 1000).toISOString() };
}

function daysLeftFromDurationSec(durationSec) {
  const secs = Number(durationSec || 0);
  if (!Number.isFinite(secs) || secs <= 0) return { days: 0, untilISO: null };
  const ms = secs * 1000;
  return {
    days: ceilDays(ms),
    untilISO: new Date(Date.now() + ms).toISOString(),
  };
}

function formatDuration(ms) {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms / 60000)}min`;
}

// Simple in-memory cache with metadata
const cache = new Map();
const setCache = (key, value, ttlMs) => {
  const now = Date.now();
  cache.set(key, { value, exp: now + ttlMs, created: now, ttl: ttlMs });
};
const getCache = (key) => {
  const it = cache.get(key);
  if (!it) return null;
  const now = Date.now();
  if (now > it.exp) {
    cache.delete(key);
    return null;
  }
  const age = now - it.created;
  const remaining = it.exp - now;
  return { 
    value: it.value, 
    age, 
    remaining,
    ageStr: formatDuration(age),
    remainingStr: formatDuration(remaining)
  };
};

// --------------------------- Providers -------------------------------------
async function pRealDebrid({ token, fetchImpl = fetch }) {
  const name = "Real-Debrid";
  const startTime = Date.now();
  
  if (!token)
    return {
      name,
      premium: null,
      daysLeft: null,
      untilISO: null,
      username: null,
      note: "missing token",
      error: true,
    };
  try {
    const res = await fetchImpl("https://api.real-debrid.com/rest/1.0/user", {
      headers: {
        Authorization: `Bearer ${token}`,
        "User-Agent": "Statusio/1.2",
      },
    });
    const elapsed = Date.now() - startTime;
    
    if (!res.ok) {
      console.log(`ERROR | Real-Debrid: HTTP ${res.status} [${elapsed}ms]`);
      return {
        name,
        premium: null,
        daysLeft: null,
        untilISO: null,
        username: null,
        note: `HTTP ${res.status}`,
        error: true,
      };
    }
    const j = await res.json();
    const username = j?.username || j?.user || null;
    const premium =
      j.premium === true ||
      String(j.type || "").toLowerCase() === "premium";
    let untilISO = null,
      days = null;

    if (j.expiration) {
      const expNum = Number(j.expiration);
      if (Number.isFinite(expNum) && expNum > 1_000_000_000) {
        const out = daysLeftFromEpochSec(expNum);
        days = out.days;
        untilISO = out.untilISO;
      } else {
        const d = new Date(j.expiration);
        if (!isNaN(d.getTime())) {
          const ms = d.getTime() - Date.now();
          days = ms > 0 ? ceilDays(ms) : 0;
          untilISO = d.toISOString();
        }
      }
    } else if (j.premium_until || j.premiumUntil) {
      const out = daysLeftFromEpochSec(
        Number(j.premium_until || j.premiumUntil)
      );
      days = out.days;
      untilISO = out.untilISO;
    }

    if (premium === true) {
      const status = days <= 0 ? "Expired" : days <= 3 ? "Critical" : days <= 14 ? "Warning" : "OK";
      console.log(`INFO | Real-Debrid: @${username || "unknown"}, ${days ?? "—"} days left (${status}) [${elapsed}ms]`);
      return {
        name,
        premium: true,
        daysLeft: days ?? null,
        untilISO: untilISO ?? null,
        username,
        error: false,
      };
    }
    if (premium === false) {
      console.log(`INFO | Real-Debrid: @${username || "unknown"}, not premium [${elapsed}ms]`);
      return {
        name,
        premium: false,
        daysLeft: 0,
        untilISO: null,
        username,
        error: false,
      };
    }
    console.log(`ERROR | Real-Debrid: status unknown [${elapsed}ms]`);
    return {
      name,
      premium: null,
      daysLeft: null,
      untilISO: null,
      username,
      note: "status unknown",
      error: true,
    };
  } catch (e) {
    const elapsed = Date.now() - startTime;
    console.log(`ERROR | Real-Debrid: network ${e.message} [${elapsed}ms]`);
    return {
      name,
      premium: null,
      daysLeft: null,
      untilISO: null,
      username: null,
      note: `network ${e.message}`,
      error: true,
    };
  }
}

async function pAllDebrid({ key, fetchImpl = fetch }) {
  const name = "AllDebrid";
  const startTime = Date.now();
  
  if (!key)
    return {
      name,
      premium: null,
      daysLeft: null,
      untilISO: null,
      username: null,
      note: "missing key",
      error: true,
    };
  try {
    const res = await fetchImpl("https://api.alldebrid.com/v4/user", {
      headers: { Authorization: `Bearer ${key}`, "User-Agent": "Statusio/1.2" },
    });
    const elapsed = Date.now() - startTime;
    
    if (!res.ok) {
      console.log(`ERROR | AllDebrid: HTTP ${res.status} [${elapsed}ms]`);
      return {
        name,
        premium: null,
        daysLeft: null,
        untilISO: null,
        username: null,
        note: `HTTP ${res.status}`,
        error: true,
      };
    }
    const j = await res.json();
    if (j?.status !== "success" || !j?.data?.user) {
      console.log(`ERROR | AllDebrid: bad response [${elapsed}ms]`);
      return {
        name,
        premium: null,
        daysLeft: null,
        untilISO: null,
        username: null,
        note: "bad response",
        error: true,
      };
    }
    const u = j.data.user;
    const username = u?.username || null;
    const isPrem = !!u.isPremium;
    let out = { days: null, untilISO: null };
    if (
      Number.isFinite(Number(u.premiumUntil)) &&
      Number(u.premiumUntil) > 0
    )
      out = daysLeftFromEpochSec(Number(u.premiumUntil));
    
    if (isPrem) {
      const status = out.days <= 0 ? "Expired" : out.days <= 3 ? "Critical" : out.days <= 14 ? "Warning" : "OK";
      console.log(`INFO | AllDebrid: @${username || "unknown"}, ${out.days ?? "—"} days left (${status}) [${elapsed}ms]`);
      return {
        name,
        premium: true,
        daysLeft: out.days,
        untilISO: out.untilISO,
        username,
        error: false,
      };
    } else {
      console.log(`INFO | AllDebrid: @${username || "unknown"}, not premium [${elapsed}ms]`);
      return {
        name,
        premium: false,
        daysLeft: 0,
        untilISO: null,
        username,
        error: false,
      };
    }
  } catch (e) {
    const elapsed = Date.now() - startTime;
    console.log(`ERROR | AllDebrid: network ${e.message} [${elapsed}ms]`);
    return {
      name,
      premium: null,
      daysLeft: null,
      untilISO: null,
      username: null,
      note: `network ${e.message}`,
      error: true,
    };
  }
}

async function pPremiumize({ key, useOAuth = false, fetchImpl = fetch }) {
  const name = "Premiumize";
  const startTime = Date.now();
  
  if (!key)
    return {
      name,
      premium: null,
      daysLeft: null,
      untilISO: null,
      username: null,
      note: "missing key",
      error: true,
    };
  try {
    const url = new URL("https://www.premiumize.me/api/account/info");
    url.searchParams.set(useOAuth ? "access_token" : "apikey", key);
    const res = await fetchImpl(url.toString(), {
      headers: { "User-Agent": "Statusio/1.2" },
    });
    const elapsed = Date.now() - startTime;
    
    if (!res.ok) {
      console.log(`ERROR | Premiumize: HTTP ${res.status} [${elapsed}ms]`);
      return {
        name,
        premium: null,
        daysLeft: null,
        untilISO: null,
        username: null,
        note: `HTTP ${res.status}`,
        error: true,
      };
    }
    const j = await res.json();
    if (String(j.status).toLowerCase() !== "success") {
      console.log(`ERROR | Premiumize: bad response [${elapsed}ms]`);
      return {
        name,
        premium: null,
        daysLeft: null,
        untilISO: null,
        username: null,
        note: "bad response",
        error: true,
      };
    }
    const out = daysLeftFromEpochSec(j.premium_until || 0);
    const isPrem = out.days > 0;
    const username = j?.customer_id ? String(j.customer_id) : null;
    
    if (isPrem) {
      const status = out.days <= 0 ? "Expired" : out.days <= 3 ? "Critical" : out.days <= 14 ? "Warning" : "OK";
      console.log(`INFO | Premiumize: @${username || "unknown"}, ${out.days} days left (${status}) [${elapsed}ms]`);
      return {
        name,
        premium: true,
        daysLeft: out.days,
        untilISO: out.untilISO,
        username,
        error: false,
      };
    } else {
      console.log(`INFO | Premiumize: @${username || "unknown"}, not premium [${elapsed}ms]`);
      return {
        name,
        premium: false,
        daysLeft: 0,
        untilISO: null,
        username,
        error: false,
      };
    }
  } catch (e) {
    const elapsed = Date.now() - startTime;
    console.log(`ERROR | Premiumize: network ${e.message} [${elapsed}ms]`);
    return {
      name,
      premium: null,
      daysLeft: null,
      untilISO: null,
      username: null,
      note: `network ${e.message}`,
      error: true,
    };
  }
}

async function pTorBox({ token, fetchImpl = fetch }) {
  const name = "TorBox";
  const startTime = Date.now();
  
  if (!token)
    return {
      name,
      premium: null,
      daysLeft: null,
      untilISO: null,
      username: null,
      note: "missing token",
      error: true,
    };

  try {
    const res = await fetchImpl(
      "https://api.torbox.app/v1/api/user/me?settings=true",
      {
        headers: {
          Authorization: `Bearer ${token}`,
          "User-Agent": "Statusio/1.2",
        },
      }
    );

    const elapsed = Date.now() - startTime;

    if (!res.ok) {
      console.log(`ERROR | TorBox: HTTP ${res.status} [${elapsed}ms]`);
      return {
        name,
        premium: null,
        daysLeft: null,
        untilISO: null,
        username: null,
        note: `HTTP ${res.status}`,
        error: true,
      };
    }

    const j = await res.json();

    if (j?.success === false && !j?.data) {
      console.log(`ERROR | TorBox: ${j.error || j.message || "unsuccessful response"} [${elapsed}ms]`);
      return {
        name,
        premium: null,
        daysLeft: null,
        untilISO: null,
        username: null,
        note: j.error || j.message || "TorBox: unsuccessful response",
        error: true,
      };
    }

    const u = j?.data || j?.user || j;
    const username = u?.username || u?.email || null;

    const isSubscribed =
      u?.is_subscribed === true || u?.isSubscribed === true;

    let days = null;
    let untilISO = null;

    const expiryIso =
      u?.premium_expires_at || u?.premiumExpiresAt || u?.premium_until_iso;
    if (expiryIso) {
      const d = new Date(expiryIso);
      if (!isNaN(d.getTime())) {
        const ms = d.getTime() - Date.now();
        days = ms > 0 ? ceilDays(ms) : 0;
        untilISO = d.toISOString();
      }
    } else if (
      u?.remainingPremiumSeconds ||
      u?.premium_left ||
      u?.premiumLeft
    ) {
      const out = daysLeftFromDurationSec(
        u.remainingPremiumSeconds || u.premium_left || u.premiumLeft
      );
      days = out.days;
      untilISO = out.untilISO;
    }

    const hasDays = typeof days === "number" && days > 0;
    const isPrem = isSubscribed || hasDays;

    if (isPrem) {
      const status = days <= 0 ? "Expired" : days <= 3 ? "Critical" : days <= 14 ? "Warning" : "OK";
      console.log(`INFO | TorBox: @${username || "unknown"}, ${hasDays ? days : "—"} days left (${status}) [${elapsed}ms]`);
      return {
        name,
        premium: true,
        daysLeft: hasDays ? days : null,
        untilISO,
        username,
        error: false,
      };
    }

    console.log(`INFO | TorBox: @${username || "unknown"}, not subscribed [${elapsed}ms]`);
    return {
      name,
      premium: false,
      daysLeft: 0,
      untilISO: null,
      username,
      note: j.error || j.message || u?.note || "not subscribed",
      error: false,
    };
  } catch (e) {
    const elapsed = Date.now() - startTime;
    console.log(`ERROR | TorBox: network ${e.message} [${elapsed}ms]`);
    return {
      name,
      premium: null,
      daysLeft: null,
      untilISO: null,
      username: null,
      note: `network ${e.message}`,
      error: true,
    };
  }
}

async function pDebridLink({
  key,
  authScheme = "Bearer",
  endpoint = "https://debrid-link.com/api/account/infos",
  fetchImpl = fetch,
}) {
  const name = "Debrid-Link";
  const startTime = Date.now();
  
  if (!key)
    return {
      name,
      premium: null,
      daysLeft: null,
      untilISO: null,
      username: null,
      note: "missing key",
      error: true,
    };
  try {
    let url = endpoint;
    const init = { headers: { "User-Agent": "Statusio/1.2" } };
    if (authScheme === "Bearer") {
      init.headers.Authorization = `Bearer ${key}`;
    } else {
      const u = new URL(endpoint);
      u.searchParams.set("apikey", key);
      url = u.toString();
    }
    const res = await fetchImpl(url, init);
    const elapsed = Date.now() - startTime;
    
    if (!res.ok) {
      console.log(`ERROR | Debrid-Link: HTTP ${res.status} [${elapsed}ms]`);
      return {
        name,
        premium: null,
        daysLeft: null,
        untilISO: null,
        username: null,
        note: `HTTP ${res.status}`,
        error: true,
      };
    }
    const j = await res.json();
    if (!j?.success || !j?.value) {
      console.log(`ERROR | Debrid-Link: bad response [${elapsed}ms]`);
      return {
        name,
        premium: null,
        daysLeft: null,
        untilISO: null,
        username: null,
        note: "bad response",
        error: true,
      };
    }
    const secs = Number(j.value.premiumLeft || 0);
    const out =
      secs > 0 ? daysLeftFromDurationSec(secs) : { days: 0, untilISO: null };
    const username = j?.value?.username || null;
    
    if (out.days > 0) {
      const status = out.days <= 0 ? "Expired" : out.days <= 3 ? "Critical" : out.days <= 14 ? "Warning" : "OK";
      console.log(`INFO | Debrid-Link: @${username || "unknown"}, ${out.days} days left (${status}) [${elapsed}ms]`);
      return {
        name,
        premium: true,
        daysLeft: out.days,
        untilISO: out.untilISO,
        username,
        error: false,
      };
    }
    
    console.log(`INFO | Debrid-Link: @${username || "unknown"}, not premium (accountType=${j.value.accountType ?? "?"}) [${elapsed}ms]`);
    return {
      name,
      premium: false,
      daysLeft: 0,
      untilISO: null,
      username,
      note: `accountType=${j.value.accountType ?? "?"}`,
      error: false,
    };
  } catch (e) {
    const elapsed = Date.now() - startTime;
    console.log(`ERROR | Debrid-Link: network ${e.message} [${elapsed}ms]`);
    return {
      name,
      premium: null,
      daysLeft: null,
      untilISO: null,
      username: null,
      note: `network ${e.message}`,
      error: true,
    };
  }
}

// --------------------------- Status Formatting -----------------------------
function getStatusInfo(days) {
  if (days <= 0) return { emoji: "🔴", label: "Expired" };
  if (days <= 3) return { emoji: "🟠", label: "Critical" };
  if (days <= 14) return { emoji: "🟡", label: "Warning" };
  return { emoji: "🟢", label: "OK" };
}

function formatProviderStatus(r) {
  const user = r?.username ? `@${String(r.username)}` : "—";
  const days = Number.isFinite(r.daysLeft) && r.daysLeft !== null
    ? r.daysLeft
    : r.premium
    ? "—"
    : 0;
  const dateStr = r.untilISO
    ? isoDate(r.untilISO)
    : r.premium
    ? "—"
    : "N/A";
  const numericDays = typeof days === "number" ? days : 9999;
  const { emoji, label } = getStatusInfo(numericDays);

  const lines = [];
  lines.push(`🤝 Service: ${r.name}`);
  lines.push(`👤 User: ${user}`);
  lines.push(`⭐ Expires: ${dateStr}`);
  lines.push(`⏳️ Days left: ${days}`);
  lines.push(`${emoji} Status: ${label}`);
  
  return lines.join("\n");
}

function formatErrorStream(r) {
  const lines = [];
  lines.push(`⚠️ Unable to check ${r.name} status`);
  lines.push(``);
  lines.push(`Error: ${r.note || "Unknown error"}`);
  lines.push(``);
  lines.push(`Troubleshooting:`);
  
  if (r.note?.includes("HTTP 401") || r.note?.includes("HTTP 403")) {
    lines.push(`• Check if your API token is valid`);
    lines.push(`• Token may have expired or been revoked`);
    lines.push(`• Verify token in your ${r.name} account`);
  } else if (r.note?.includes("HTTP 429")) {
    lines.push(`• Rate limit exceeded`);
    lines.push(`• Wait a few minutes before retrying`);
  } else if (r.note?.includes("HTTP 5")) {
    lines.push(`• ${r.name} service may be down`);
    lines.push(`• Check ${r.name} status page`);
    lines.push(`• Try again in a few minutes`);
  } else if (r.note?.includes("network")) {
    lines.push(`• Check your internet connection`);
    lines.push(`• ${r.name} API may be unreachable`);
    lines.push(`• Try again later`);
  } else if (r.note === "missing token" || r.note === "missing key") {
    lines.push(`• API token not configured`);
    lines.push(`• Add your ${r.name} token in settings`);
  } else {
    lines.push(`• Check your ${r.name} account status`);
    lines.push(`• Verify API credentials are correct`);
    lines.push(`• Check addon logs for details`);
  }
  
  return lines.join("\n");
}

// --------------------------- Manifest --------------------------------------
const manifest = {
  id: "a1337user.statusio.critical.only",
  version: "1.2.0",
  name: "Statusio (Critical/Expired Only)",
  description:
    "Shows premium status ONLY when ≤3 days remaining or expired.",
  resources: ["stream"],
  types: ["movie", "series"],
  idPrefixes: ["tt"],
  catalogs: [],
  behaviorHints: { configurable: true, configurationRequired: false },
  logo: LOGO_URL,
  config: [
    {
      key: "cache_minutes",
      type: "number",
      default: "45",
      title: "Cache Minutes (default 45)",
    },
    {
      key: "show_errors",
      type: "select",
      options: ["true", "false"],
      default: "true",
      title: "Show error streams for failed checks",
    },
    { key: "rd_token", type: "text", title: "Real-Debrid Token (Bearer)" },
    { key: "ad_key", type: "text", title: "AllDebrid API Key (Bearer)" },
    {
      key: "pm_key",
      type: "text",
      title: "Premiumize apikey OR access_token",
    },
    { key: "tb_token", type: "text", title: "TorBox Token (Bearer)" },
    { key: "dl_key", type: "text", title: "Debrid-Link API Key/Token" },
    {
      key: "dl_auth",
      type: "text",
      title: "Debrid-Link Auth Scheme (Bearer/query)",
      default: "Bearer",
    },
    {
      key: "dl_endpoint",
      type: "text",
      title: "Debrid-Link Endpoint Override",
      default: "https://debrid-link.com/api/account/infos",
    },
  ],
};

const builder = new addonBuilder(manifest);

// --------------------------- Shared Data Fetching --------------------------
async function fetchStatusData(cfg) {
  const cacheMin = Number.isFinite(Number(cfg.cache_minutes))
    ? Math.max(1, Number(cfg.cache_minutes))
    : 45;

  const tokens = {
    rd: String(cfg.rd_token || process.env.RD_TOKEN || "").trim(),
    ad: String(cfg.ad_key || process.env.AD_KEY || "").trim(),
    pm: String(cfg.pm_key || process.env.PM_KEY || "").trim(),
    tb: String(cfg.tb_token || process.env.TB_TOKEN || "").trim(),
    dl: String(cfg.dl_key || process.env.DL_KEY || "").trim(),
  };

  const enabled = {
    realdebrid: !!tokens.rd,
    alldebrid: !!tokens.ad,
    premiumize: !!tokens.pm,
    torbox: !!tokens.tb,
    debridlink: !!tokens.dl,
  };

  const cacheKey = [
    Object.entries(enabled)
      .filter(([, v]) => v)
      .map(([k]) => k)
      .join(","),
    `rd:${redact(tokens.rd)}`,
    `ad:${redact(tokens.ad)}`,
    `pm:${redact(tokens.pm)}`,
    `tb:${redact(tokens.tb)}`,
    `dl:${redact(tokens.dl)}:${cfg.dl_auth || "Bearer"}:${
      cfg.dl_endpoint || ""
    }`,
  ].join("|");

  const cached = getCache(cacheKey);
  
  return {
    cached,
    enabled,
    async fetch() {
      if (cached) {
        return {
          results: cached.value,
          cacheStatus: `HIT (age: ${cached.ageStr}, expires in: ${cached.remainingStr})`,
          enabled,
          hasData: cached.value.some((r) => r.premium !== null || r.username),
        };
      }

      try {
        const jobs = [];
        if (enabled.realdebrid) jobs.push(pRealDebrid({ token: tokens.rd }));
        if (enabled.alldebrid) jobs.push(pAllDebrid({ key: tokens.ad }));
        if (enabled.premiumize) jobs.push(pPremiumize({ key: tokens.pm }));
        if (enabled.torbox) jobs.push(pTorBox({ token: tokens.tb }));
        if (enabled.debridlink)
          jobs.push(
            pDebridLink({
              key: tokens.dl,
              authScheme: cfg.dl_auth || "Bearer",
              endpoint: (cfg.dl_endpoint ||
                "https://debrid-link.com/api/account/infos"
              ).trim(),
            })
          );
        const results = jobs.length ? await Promise.all(jobs) : [];
        setCache(cacheKey, results, cacheMin * MIN);
        
        return {
          results,
          enabled,
          hasData: results.some((r) => r.premium !== null || r.username),
        };
      } catch (e) {
        console.error("ERROR | Error fetching provider data:", e);
        return { error: e.message, results: [], enabled, hasData: false };
      }
    }
  };
}

// --------------------------- Cache Warming ---------------------------------
async function warmCache() {
  const tokens = {
    rd: String(process.env.RD_TOKEN || "").trim(),
    ad: String(process.env.AD_KEY || "").trim(),
    pm: String(process.env.PM_KEY || "").trim(),
    tb: String(process.env.TB_TOKEN || "").trim(),
    dl: String(process.env.DL_KEY || "").trim(),
  };

  const enabledServices = [];
  if (tokens.rd) enabledServices.push("Real-Debrid");
  if (tokens.ad) enabledServices.push("AllDebrid");
  if (tokens.pm) enabledServices.push("Premiumize");
  if (tokens.tb) enabledServices.push("TorBox");
  if (tokens.dl) enabledServices.push("Debrid-Link");

  if (enabledServices.length === 0) {
    console.log("INFO | No services configured via environment variables");
    return;
  }

  console.log(`INFO | Enabled services: ${enabledServices.join(", ")}`);
  console.log("INFO | Warming cache on startup...");

  try {
    const statusData = await fetchStatusData({
      cache_minutes: 45,
      rd_token: tokens.rd,
      ad_key: tokens.ad,
      pm_key: tokens.pm,
      tb_token: tokens.tb,
      dl_key: tokens.dl,
    });
    await statusData.fetch();
    console.log(`INFO | Cache warming complete (${enabledServices.length} provider${enabledServices.length > 1 ? 's' : ''} checked)`);
  } catch (e) {
    console.error("ERROR | Cache warming failed:", e.message);
  }
}

// ---------------------------- Stream Handler -------------------------------
builder.defineStreamHandler(async (args) => {
  const reqId = String(args?.id || "");
  if (!reqId || !reqId.startsWith("tt")) return { streams: [] };

  const rawCfg = args?.config ?? {};
  let cfg = {};
  if (typeof rawCfg === "string") {
    try {
      cfg = JSON.parse(rawCfg);
    } catch {
      console.log("WARN | Config parse error");
      cfg = {};
    }
  } else if (typeof rawCfg === "object" && rawCfg !== null) {
    cfg = rawCfg;
  }

  const statusData = await fetchStatusData(cfg);

  if (!Object.values(statusData.enabled).some((v) => v)) {
    console.log("WARN | No providers configured");
    return { streams: [] };
  }

  const enabledList = Object.entries(statusData.enabled)
    .filter(([, v]) => v)
    .map(([k]) => k)
    .join(", ");

  const showErrors = cfg.show_errors !== "false"; // default true
  const streams = [];
  const errorStreams = [];

  console.log(`INFO | Stream request: ${reqId} | providers: ${enabledList}`);

  const statusData = fetchStatusData(cfg);
  
  // Fetch data (cache status will be logged inside fetch)
  const data = await statusData.fetch();

  if (data.hasData) {
    for (const r of data.results) {
      // Handle errors
      if (r.error) {
        if (showErrors) {
          console.log(`INFO | Adding error stream: ${r.name} check failed (${r.note})`);
          errorStreams.push({
            name: `⚠️ ${r.name} Error`,
            description: formatErrorStream(r),
            url: "https://real-debrid.com/",
            externalUrl: "https://real-debrid.com/",
            behaviorHints: { notWebReady: true },
          });
        }
        continue;
      }

      if (r.premium !== null || r.username) {
        const days = Number.isFinite(r.daysLeft) && r.daysLeft !== null
          ? r.daysLeft
          : r.premium
          ? 9999
          : 0;
        
        // ONLY show if critical (≤3 days) or expired (≤0)
        if (days > 3) {
          continue; // Silently filter out non-critical
        }

        streams.push({
          name: "🔐 Statusio",
          description: formatProviderStatus(r),
          url: "https://real-debrid.com/",
          externalUrl: "https://real-debrid.com/",
          behaviorHints: { notWebReady: true },
        });
      }
    }
  }

  const allStreams = [...streams, ...errorStreams];
  const MAX_TV_STREAMS = 3;
  const finalStreams = allStreams.slice(0, MAX_TV_STREAMS);

  console.log(`INFO | Returning ${finalStreams.length} streams`);

  return { streams: finalStreams };
});

// ------------------------------ Server -------------------------------------
const PORT = Number(process.env.PORT || 7042);
serveHTTP(builder.getInterface(), { port: PORT, hostname: "0.0.0.0" });

console.log(`INFO | Statusio v1.2.0 started on port ${PORT}`);
console.log("INFO | Showing only critical (≤3 days) or expired subscriptions");

// Warm cache after server starts
warmCache();

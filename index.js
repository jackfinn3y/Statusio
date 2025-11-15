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

// Simple in-memory cache
const cache = new Map();
const setCache = (key, value, ttlMs) =>
  cache.set(key, { value, exp: Date.now() + ttlMs });
const getCache = (key) => {
  const it = cache.get(key);
  if (!it) return null;
  if (Date.now() > it.exp) {
    cache.delete(key);
    return null;
  }
  return it.value;
};

// --------------------------- Providers -------------------------------------
async function pRealDebrid({ token, fetchImpl = fetch }) {
  const name = "Real-Debrid";
  if (!token)
    return {
      name,
      premium: null,
      daysLeft: null,
      untilISO: null,
      username: null,
      note: "missing token",
    };
  try {
    const res = await fetchImpl("https://api.real-debrid.com/rest/1.0/user", {
      headers: {
        Authorization: `Bearer ${token}`,
        "User-Agent": "Statusio/1.2",
      },
    });
    if (!res.ok)
      return {
        name,
        premium: null,
        daysLeft: null,
        untilISO: null,
        username: null,
        note: `HTTP ${res.status}`,
      };
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

    if (premium === true)
      return {
        name,
        premium: true,
        daysLeft: days ?? null,
        untilISO: untilISO ?? null,
        username,
      };
    if (premium === false)
      return {
        name,
        premium: false,
        daysLeft: 0,
        untilISO: null,
        username,
      };
    return {
      name,
      premium: null,
      daysLeft: null,
      untilISO: null,
      username,
      note: "status unknown",
    };
  } catch (e) {
    return {
      name,
      premium: null,
      daysLeft: null,
      untilISO: null,
      username: null,
      note: `network ${e.message}`,
    };
  }
}

async function pAllDebrid({ key, fetchImpl = fetch }) {
  const name = "AllDebrid";
  if (!key)
    return {
      name,
      premium: null,
      daysLeft: null,
      untilISO: null,
      username: null,
      note: "missing key",
    };
  try {
    const res = await fetchImpl("https://api.alldebrid.com/v4/user", {
      headers: { Authorization: `Bearer ${key}`, "User-Agent": "Statusio/1.2" },
    });
    if (!res.ok)
      return {
        name,
        premium: null,
        daysLeft: null,
        untilISO: null,
        username: null,
        note: `HTTP ${res.status}`,
      };
    const j = await res.json();
    if (j?.status !== "success" || !j?.data?.user)
      return {
        name,
        premium: null,
        daysLeft: null,
        untilISO: null,
        username: null,
        note: "bad response",
      };
    const u = j.data.user;
    const username = u?.username || null;
    const isPrem = !!u.isPremium;
    let out = { days: null, untilISO: null };
    if (
      Number.isFinite(Number(u.premiumUntil)) &&
      Number(u.premiumUntil) > 0
    )
      out = daysLeftFromEpochSec(Number(u.premiumUntil));
    return isPrem
      ? {
          name,
          premium: true,
          daysLeft: out.days,
          untilISO: out.untilISO,
          username,
        }
      : {
          name,
          premium: false,
          daysLeft: 0,
          untilISO: null,
          username,
        };
  } catch (e) {
    return {
      name,
      premium: null,
      daysLeft: null,
      untilISO: null,
      username: null,
      note: `network ${e.message}`,
    };
  }
}

async function pPremiumize({ key, useOAuth = false, fetchImpl = fetch }) {
  const name = "Premiumize";
  if (!key)
    return {
      name,
      premium: null,
      daysLeft: null,
      untilISO: null,
      username: null,
      note: "missing key",
    };
  try {
    const url = new URL("https://www.premiumize.me/api/account/info");
    url.searchParams.set(useOAuth ? "access_token" : "apikey", key);
    const res = await fetchImpl(url.toString(), {
      headers: { "User-Agent": "Statusio/1.2" },
    });
    if (!res.ok)
      return {
        name,
        premium: null,
        daysLeft: null,
        untilISO: null,
        username: null,
        note: `HTTP ${res.status}`,
      };
    const j = await res.json();
    if (String(j.status).toLowerCase() !== "success")
      return {
        name,
        premium: null,
        daysLeft: null,
        untilISO: null,
        username: null,
        note: "bad response",
      };
    const out = daysLeftFromEpochSec(j.premium_until || 0);
    const isPrem = out.days > 0;
    const username = j?.customer_id ? String(j.customer_id) : null;
    return isPrem
      ? {
          name,
          premium: true,
          daysLeft: out.days,
          untilISO: out.untilISO,
          username,
        }
      : {
          name,
          premium: false,
          daysLeft: 0,
          untilISO: null,
          username,
        };
  } catch (e) {
    return {
      name,
      premium: null,
      daysLeft: null,
      untilISO: null,
      username: null,
      note: `network ${e.message}`,
    };
  }
}

async function pTorBox({ token, fetchImpl = fetch }) {
  const name = "TorBox";
  if (!token)
    return {
      name,
      premium: null,
      daysLeft: null,
      untilISO: null,
      username: null,
      note: "missing token",
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

    if (!res.ok) {
      return {
        name,
        premium: null,
        daysLeft: null,
        untilISO: null,
        username: null,
        note: `HTTP ${res.status}`,
      };
    }

    const j = await res.json();

    if (j?.success === false && !j?.data) {
      return {
        name,
        premium: null,
        daysLeft: null,
        untilISO: null,
        username: null,
        note: j.error || j.message || "TorBox: unsuccessful response",
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
      return {
        name,
        premium: true,
        daysLeft: hasDays ? days : null,
        untilISO,
        username,
      };
    }

    return {
      name,
      premium: false,
      daysLeft: 0,
      untilISO: null,
      username,
      note: j.error || j.message || u?.note || "not subscribed",
    };
  } catch (e) {
    return {
      name,
      premium: null,
      daysLeft: null,
      untilISO: null,
      username: null,
      note: `network ${e.message}`,
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
  if (!key)
    return {
      name,
      premium: null,
      daysLeft: null,
      untilISO: null,
      username: null,
      note: "missing key",
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
    if (!res.ok)
      return {
        name,
        premium: null,
        daysLeft: null,
        untilISO: null,
        username: null,
        note: `HTTP ${res.status}`,
      };
    const j = await res.json();
    if (!j?.success || !j?.value)
      return {
        name,
        premium: null,
        daysLeft: null,
        untilISO: null,
        username: null,
        note: "bad response",
      };
    const secs = Number(j.value.premiumLeft || 0);
    const out =
      secs > 0 ? daysLeftFromDurationSec(secs) : { days: 0, untilISO: null };
    const username = j?.value?.username || null;
    if (out.days > 0)
      return {
        name,
        premium: true,
        daysLeft: out.days,
        untilISO: out.untilISO,
        username,
      };
    return {
      name,
      premium: false,
      daysLeft: 0,
      untilISO: null,
      username,
      note: `accountType=${j.value.accountType ?? "?"}`,
    };
  } catch (e) {
    return {
      name,
      premium: null,
      daysLeft: null,
      untilISO: null,
      username: null,
      note: `network ${e.message}`,
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

  let results = getCache(cacheKey);
  if (!results) {
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
      results = jobs.length ? await Promise.all(jobs) : [];
      setCache(cacheKey, results, cacheMin * MIN);
    } catch (e) {
      console.error("[Statusio] Error fetching provider data:", e);
      return { error: e.message, results: [], enabled, hasData: false };
    }
  }

  return {
    results,
    enabled,
    hasData: results.some((r) => r.premium !== null || r.username),
  };
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
      cfg = {};
    }
  } else if (typeof rawCfg === "object" && rawCfg !== null) {
    cfg = rawCfg;
  }

  const statusData = await fetchStatusData(cfg);

  if (!Object.values(statusData.enabled).some((v) => v)) return { streams: [] };

  const streams = [];
  if (statusData.hasData) {
    for (const r of statusData.results) {
      if (r.premium !== null || r.username) {
        const days = Number.isFinite(r.daysLeft) && r.daysLeft !== null
          ? r.daysLeft
          : r.premium
          ? 9999
          : 0;
        
        // ONLY show if critical (≤3 days) or expired (≤0)
        if (days > 3) continue;

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

  const MAX_TV_STREAMS = 3;
  const finalStreams = streams.slice(0, MAX_TV_STREAMS);

  return { streams: finalStreams };
});

// ----------------------- Configuration UI HTML -----------------------------
const CONFIG_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Statusio Configuration</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            min-height: 100vh;
            display: flex;
            align-items: center;
            justify-content: center;
            padding: 20px;
        }
        .container {
            background: rgba(255, 255, 255, 0.95);
            border-radius: 20px;
            padding: 40px;
            max-width: 600px;
            width: 100%;
            box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3);
            max-height: 90vh;
            overflow-y: auto;
        }
        .header { text-align: center; margin-bottom: 30px; }
        .logo {
            width: 80px;
            height: 80px;
            margin: 0 auto 15px;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            border-radius: 20px;
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 40px;
        }
        h1 { color: #2d3748; font-size: 28px; margin-bottom: 10px; }
        .subtitle { color: #718096; font-size: 14px; }
        .form-group { margin-bottom: 25px; }
        label {
            display: block;
            color: #2d3748;
            font-weight: 600;
            margin-bottom: 8px;
            font-size: 14px;
        }
        .provider-label { display: flex; align-items: center; gap: 10px; }
        .provider-logo {
            width: 24px;
            height: 24px;
            object-fit: contain;
            border-radius: 4px;
            background: white;
            padding: 2px;
        }
        input[type="text"], input[type="number"], select {
            width: 100%;
            padding: 12px 16px;
            border: 2px solid #e2e8f0;
            border-radius: 10px;
            font-size: 14px;
            transition: all 0.3s ease;
            font-family: monospace;
            background: white;
        }
        select {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            cursor: pointer;
        }
        input:focus, select:focus {
            outline: none;
            border-color: #667eea;
            box-shadow: 0 0 0 3px rgba(102, 126, 234, 0.1);
        }
        .helper-text { font-size: 12px; color: #718096; margin-top: 5px; }
        .button-group { display: flex; gap: 12px; margin-top: 30px; }
        button {
            flex: 1;
            padding: 14px 24px;
            border: none;
            border-radius: 10px;
            font-size: 16px;
            font-weight: 600;
            cursor: pointer;
            transition: all 0.3s ease;
        }
        .btn-primary {
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
        }
        .btn-primary:hover {
            transform: translateY(-2px);
            box-shadow: 0 10px 25px rgba(102, 126, 234, 0.4);
        }
        .btn-secondary { background: #e2e8f0; color: #2d3748; }
        .btn-secondary:hover { background: #cbd5e0; }
        .success-message {
            background: #48bb78;
            color: white;
            padding: 12px 16px;
            border-radius: 10px;
            margin-bottom: 20px;
            display: none;
            animation: slideIn 0.3s ease;
        }
        @keyframes slideIn {
            from { opacity: 0; transform: translateY(-10px); }
            to { opacity: 1; transform: translateY(0); }
        }
        .addon-url {
            background: #f7fafc;
            border: 2px dashed #cbd5e0;
            border-radius: 10px;
            padding: 16px;
            margin-top: 30px;
            text-align: center;
        }
        .addon-url-label {
            font-size: 12px;
            color: #718096;
            font-weight: 600;
            margin-bottom: 8px;
            text-transform: uppercase;
            letter-spacing: 0.5px;
        }
        .url-display {
            font-family: monospace;
            font-size: 13px;
            color: #2d3748;
            word-break: break-all;
            background: white;
            padding: 10px;
            border-radius: 6px;
            margin-bottom: 10px;
        }
        .copy-btn {
            padding: 8px 16px;
            font-size: 14px;
            background: #667eea;
            color: white;
            border: none;
            border-radius: 6px;
            cursor: pointer;
            transition: all 0.3s ease;
        }
        .copy-btn:hover { background: #5568d3; }
        .section-divider {
            border: none;
            border-top: 2px solid #e2e8f0;
            margin: 30px 0;
        }
        .section-title {
            font-size: 18px;
            color: #2d3748;
            font-weight: 700;
            margin-bottom: 15px;
            display: flex;
            align-items: center;
            gap: 8px;
        }
        .advanced-section {
            background: #f7fafc;
            padding: 20px;
            border-radius: 10px;
            margin-top: 20px;
        }
        .advanced-title {
            font-size: 14px;
            color: #4a5568;
            font-weight: 600;
            margin-bottom: 15px;
            text-transform: uppercase;
            letter-spacing: 0.5px;
        }
        @media (max-width: 640px) {
            .container { padding: 30px 20px; }
            h1 { font-size: 24px; }
            .button-group { flex-direction: column; }
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <div class="logo">🔐</div>
            <h1>Statusio Configuration</h1>
            <p class="subtitle">Monitor your debrid service subscriptions</p>
        </div>
        <div id="successMessage" class="success-message">✓ Configuration saved successfully!</div>
        <form id="configForm">
            <div class="section-title">⚙️ General Settings</div>
            <div class="form-group">
                <label for="cache_minutes">Cache Duration (minutes)</label>
                <input type="number" id="cache_minutes" name="cache_minutes" value="45" min="1" max="1440">
                <div class="helper-text">How long to cache API responses (1-1440 minutes)</div>
            </div>
            <hr class="section-divider">
            <div class="section-title">🌐 Debrid Services</div>
            <div class="form-group">
                <label for="rd_token">
                    <span class="provider-label">
                        <img src="https://fcdn.real-debrid.com/0831/images/logo.png" alt="Real-Debrid" class="provider-logo">
                        Real-Debrid Token
                    </span>
                </label>
                <input type="text" id="rd_token" name="rd_token" placeholder="Bearer token from Real-Debrid">
                <div class="helper-text">Get from: Account Settings → API Token</div>
            </div>
            <div class="form-group">
                <label for="ad_key">
                    <span class="provider-label">
                        <img src="https://cdn.alldebrid.com/lib/images/default/logo_alldebrid.png" alt="AllDebrid" class="provider-logo">
                        AllDebrid API Key
                    </span>
                </label>
                <input type="text" id="ad_key" name="ad_key" placeholder="API key from AllDebrid">
                <div class="helper-text">Get from: Account Settings → API Key</div>
            </div>
            <div class="form-group">
                <label for="pm_key">
                    <span class="provider-label">
                        <img src="https://www.premiumize.me/icon_normal.svg" alt="Premiumize" class="provider-logo">
                        Premiumize Key
                    </span>
                </label>
                <input type="text" id="pm_key" name="pm_key" placeholder="API key or access token">
                <div class="helper-text">Get from: Account Settings → API Key</div>
            </div>
            <div class="form-group">
                <label for="tb_token">
                    <span class="provider-label">
                        <img src="https://avatars.githubusercontent.com/u/144096078?s=280&v=4" alt="TorBox" class="provider-logo">
                        TorBox Token
                    </span>
                </label>
                <input type="text" id="tb_token" name="tb_token" placeholder="Bearer token from TorBox">
                <div class="helper-text">Get from: Account Settings → API Token</div>
            </div>
            <div class="form-group">
                <label for="dl_key">
                    <span class="provider-label">
                        <img src="https://debrid-link.com/img/brand/dl-white-blue.svg" alt="Debrid-Link" class="provider-logo">
                        Debrid-Link Key
                    </span>
                </label>
                <input type="text" id="dl_key" name="dl_key" placeholder="API key from Debrid-Link">
                <div class="helper-text">Get from: Account Settings → API Key</div>
            </div>
            <div class="advanced-section">
                <div class="advanced-title">🔧 Advanced: Debrid-Link Options</div>
                <div class="form-group">
                    <label for="dl_auth">Authentication Scheme</label>
                    <select id="dl_auth" name="dl_auth">
                        <option value="Bearer">Bearer (Recommended)</option>
                        <option value="query">Query Parameter</option>
                    </select>
                    <div class="helper-text">How to send the API key to Debrid-Link</div>
                </div>
                <div class="form-group">
                    <label for="dl_endpoint">Custom API Endpoint</label>
                    <input type="text" id="dl_endpoint" name="dl_endpoint" placeholder="https://debrid-link.com/api/account/infos">
                    <div class="helper-text">Leave empty to use default endpoint</div>
                </div>
            </div>
            <div class="button-group">
                <button type="button" class="btn-secondary" onclick="clearForm()">Clear All</button>
                <button type="submit" class="btn-primary">Generate Addon URL</button>
            </div>
        </form>
        <div class="addon-url" id="addonUrlSection" style="display: none;">
            <div class="addon-url-label">Your Addon URL</div>
            <div class="url-display" id="addonUrl"></div>
            <button class="copy-btn" onclick="copyUrl()">📋 Copy URL</button>
            <div class="helper-text" style="margin-top: 10px;">
                Paste this URL in Stremio: Settings → Addons → Add Addon
            </div>
        </div>
    </div>
    <script>
        const BASE_URL = window.location.origin;
        window.addEventListener('DOMContentLoaded', () => {
            const saved = JSON.parse(localStorage.getItem('statusioConfig') || '{}');
            Object.keys(saved).forEach(key => {
                const input = document.getElementById(key);
                if (input) input.value = saved[key];
            });
        });
        document.getElementById('configForm').addEventListener('submit', (e) => {
            e.preventDefault();
            const formData = new FormData(e.target);
            const config = {};
            for (let [key, value] of formData.entries()) {
                if (value.trim()) {
                    config[key] = value.trim();
                }
            }
            localStorage.setItem('statusioConfig', JSON.stringify(config));
            const configEncoded = btoa(JSON.stringify(config));
            const addonUrl = BASE_URL + '/' + configEncoded + '/manifest.json';
            document.getElementById('addonUrl').textContent = addonUrl;
            document.getElementById('addonUrlSection').style.display = 'block';
            const successMsg = document.getElementById('successMessage');
            successMsg.style.display = 'block';
            setTimeout(() => { successMsg.style.display = 'none'; }, 3000);
            document.getElementById('addonUrlSection').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        });
        function clearForm() {
            if (confirm('Clear all saved configuration?')) {
                localStorage.removeItem('statusioConfig');
                document.getElementById('configForm').reset();
                document.getElementById('addonUrlSection').style.display = 'none';
            }
        }
        function copyUrl() {
            const url = document.getElementById('addonUrl').textContent;
            navigator.clipboard.writeText(url).then(() => {
                const btn = event.target;
                const originalText = btn.textContent;
                btn.textContent = '✓ Copied!';
                btn.style.background = '#48bb78';
                setTimeout(() => {
                    btn.textContent = originalText;
                    btn.style.background = '#667eea';
                }, 2000);
            });
        }
    </script>
</body>
</html>`

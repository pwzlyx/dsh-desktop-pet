/**
 * dsh-desktop-pet — quota parsing (pure, testable).
 *
 * Normalizes the GLM Coding Plan usage/quota payload into display windows.
 * Two response dialects are supported:
 *
 *  1. bigmodel.cn 新积分制套餐 (post 2026-07-30 plan revision):
 *     GET https://bigmodel.cn/api/monitor/usage/quota/limit?type={1|2}
 *       authorization: <raw key>            (NO Bearer prefix)
 *       bigmodel-organization: org-xxx      (required)
 *       bigmodel-project: proj_xxx          (required)
 *     data.limits[] rows of type CREDIT_LIMIT with unit/number semantics:
 *       unit 3 = hours (number 5 → rolling 5h window)
 *       unit 6 = weeks (number 1 → weekly window)
 *
 *  2. z.ai / bigmodel Bearer dialect (opencodex-compatible):
 *     GET https://{api.z.ai|open.bigmodel.cn}/api/monitor/usage/quota/limit
 *       Authorization: Bearer <key>
 *     data.limits[] rows of type TOKENS_LIMIT | CREDIT_LIMIT | TIME_LIMIT;
 *     TOKENS/CREDIT rows use the same unit/number semantics, TIME_LIMIT is
 *     the monthly MCP tool budget. Legacy field-shaped payloads
 *     (fiveHourPercent/weeklyPercent/... directly on data) are a fallback.
 *
 * Every row's `percentage` is the CONSUMED share; `remaining` is the leftover
 * credits; `nextResetTime` is unix ms.
 */

/** @typedef {{label:string,total:number,remaining:number,pct:number,resetAt:number,kind:"credit"|"time"}} QuotaWindow */

/**
 * @param {unknown} v @returns {number|undefined}
 */
function finite(v) {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Classify one limits[] row into a display window, or null.
 * @param {Record<string, unknown>} row
 * @returns {QuotaWindow|null}
 */
function classifyRow(row) {
  const type = row.type;
  let kind = null;
  let label = null;
  if (type === "TOKENS_LIMIT" || type === "CREDIT_LIMIT") {
    kind = "credit";
    const unit = finite(row.unit);
    const number = finite(row.number);
    if (unit === 3) label = `${number ?? "?"}h`;
    else if (unit === 6) label = number === 1 ? "周" : `${number ?? "?"}w`;
    else label = `u${unit ?? "?"}x${number ?? "?"}`;
  } else if (type === "TIME_LIMIT") {
    kind = "time";
    label = "MCP/月";
  } else {
    return null;
  }

  let pct = finite(row.percentage);
  const used = finite(row.currentValue);
  const total = finite(row.usage);
  if (pct === undefined && used !== undefined && total !== undefined && total > 0) {
    pct = (used / total) * 100;
  }
  if (pct === undefined) return null;
  if (pct < 0) pct = 0;
  if (pct > 100) pct = 100;

  return {
    label,
    kind,
    total: total ?? 0,
    remaining: finite(row.remaining) ?? 0,
    pct: Math.round(pct * 10) / 10,
    resetAt: finite(row.nextResetTime) ?? 0,
  };
}

/**
 * Legacy field-shaped payload fallback (older z.ai responses).
 * @param {Record<string, unknown>} data
 * @returns {QuotaWindow[]}
 */
function parseLegacyFields(data) {
  const nested = (data.quota && typeof data.quota === "object") ? data.quota : data;
  const out = [];
  const pctAt = (keys) => {
    for (const k of keys) {
      const v = finite(nested[k]);
      if (v !== undefined) return v;
    }
    return undefined;
  };
  const fiveHour = pctAt(["fiveHourPercent", "fiveHourUsage", "fiveHourUsed"]);
  const weekly = pctAt(["weeklyPercent", "weeklyUsage", "weeklyUsed"]);
  const monthly = pctAt(["monthlyPercent", "monthlyUsage", "monthlyUsed"]);
  if (fiveHour !== undefined) out.push({ label: "5h", kind: "credit", total: 0, remaining: 0, pct: Math.round(fiveHour * 10) / 10, resetAt: finite(nested.fiveHourResetAt) ?? 0 });
  if (weekly !== undefined) out.push({ label: "周", kind: "credit", total: 0, remaining: 0, pct: Math.round(weekly * 10) / 10, resetAt: finite(nested.weeklyResetAt) ?? 0 });
  if (monthly !== undefined) out.push({ label: "MCP/月", kind: "time", total: 0, remaining: 0, pct: Math.round(monthly * 10) / 10, resetAt: finite(nested.monthlyResetAt) ?? 0 });
  return out;
}

/**
 * Normalize a quota HTTP JSON body into windows + plan level.
 * @param {unknown} body parsed JSON of the quota endpoint response
 * @returns {{windows: QuotaWindow[], level: string|null}}
 */
function normalizeQuota(body) {
  if (!body || typeof body !== "object") return { windows: [], level: null };
  const b = /** @type {Record<string, unknown>} */ (body);
  if (b.success === false) {
    const msg = typeof b.msg === "string" ? b.msg : "quota API returned success:false";
    const err = new Error(msg);
    err.code = finite(b.code) ?? 0;
    throw err;
  }
  const data = (b.data && typeof b.data === "object") ? /** @type {Record<string, unknown>} */ (b.data) : b;
  const level = typeof data.level === "string" ? data.level : null;

  if (Array.isArray(data.limits)) {
    const windows = [];
    for (const raw of data.limits) {
      if (!raw || typeof raw !== "object") continue;
      const w = classifyRow(/** @type {Record<string, unknown>} */ (raw));
      if (w) windows.push(w);
    }
    // Earliest-reset first: the 5h window is what the user watches most.
    windows.sort((a, x) => a.resetAt - x.resetAt);
    if (windows.length > 0) return { windows, level };
  }
  return { windows: parseLegacyFields(data), level };
}

/**
 * Build the outbound request (URL + headers) for a provider preset.
 * bigmodel.cn credit plans need raw-key auth + org/project headers + type;
 * z.ai uses Bearer. Both share the /api/monitor/usage/quota/limit path.
 * @param {{provider?:string, organization?:string, project?:string, type?:number|string}} cfg
 */
function quotaRequest(cfg) {
  const provider = cfg.provider || "zai-coding-cn";
  if (provider === "zai") {
    return {
      url: "https://api.z.ai/api/monitor/usage/quota/limit",
      headers: { accept: "application/json", authorization: "" /* Bearer filled by caller */ },
      bearer: true,
    };
  }
  const type = String(cfg.type ?? 2);
  return {
    url: `https://bigmodel.cn/api/monitor/usage/quota/limit?type=${encodeURIComponent(type)}`,
    headers: {
      accept: "application/json",
      authorization: "" /* raw key filled by caller */,
      ...(cfg.organization ? { "bigmodel-organization": cfg.organization } : {}),
      ...(cfg.project ? { "bigmodel-project": cfg.project } : {}),
    },
    bearer: false,
  };
}

/**
 * Countdown like "1h22m" / "4d3h" / "45s".
 * @param {number} resetAt unix ms
 * @param {number} now unix ms
 */
function fmtCountdown(resetAt, now = Date.now()) {
  let sec = Math.max(0, Math.floor((resetAt - now) / 1000));
  if (sec <= 0) return "0s";
  const d = Math.floor(sec / 86400); sec -= d * 86400;
  const h = Math.floor(sec / 3600); sec -= h * 3600;
  const m = Math.floor(sec / 60); sec -= m * 60;
  if (d > 0) return `${d}d${h}h`;
  if (h > 0) return `${h}h${m}m`;
  if (m > 0) return `${m}m${sec}s`;
  return `${sec}s`;
}

/**
 * Compact number: 12345 → "12,345"; 1234567 → "1.2M".
 * @param {number} n
 */
function fmtNum(n) {
  if (!Number.isFinite(n)) return "–";
  if (Math.abs(n) >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, "") + "M";
  if (Math.abs(n) >= 1e4) return (n / 1e3).toFixed(1).replace(/\.0$/, "") + "k";
  return String(Math.round(n * 10) / 10);
}

export { normalizeQuota, quotaRequest, fmtCountdown, fmtNum };

/**
 * Util.gs — small shared helpers (no side effects).
 */

/** Read a required Script Property or throw a clear error. */
function prop_(key, required) {
  var v = PropertiesService.getScriptProperties().getProperty(key);
  if (required && !v) {
    throw new Error('Missing Script Property "' + key + '". Set it in Project Settings → Script Properties (see SETUP.md).');
  }
  return v;
}

function setProp_(key, value) {
  PropertiesService.getScriptProperties().setProperty(key, value);
}

/** Zoho accounts (OAuth) base for the configured DC. */
function zohoAccountsBase_() { return 'https://accounts.zoho.' + CONFIG.zoho.dc; }

/** Zoho Books API base for the configured DC. */
function zohoApiBase_() { return 'https://www.zohoapis.' + CONFIG.zoho.dc + '/books/v3'; }

/** Build a URL query string from an object (skips null/undefined). */
function toQuery_(params) {
  var parts = [];
  Object.keys(params || {}).forEach(function (k) {
    var v = params[k];
    if (v === null || v === undefined || v === '') return;
    parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(v));
  });
  return parts.join('&');
}

/** Exponential backoff with jitter (ms) for retry attempt N (0-based). Zoho sends no Retry-After. */
function backoffMs_(attempt) {
  var base = Math.min(30000, Math.pow(2, attempt) * 1000); // 1s,2s,4s,8s,16s (cap 30s)
  return Math.floor(base / 2 + Math.random() * base / 2);
}

/** Parse 'YYYY-MM-DD' (Zoho invoice date) into a local Date at midnight, TZ-safe. */
function parseIsoDate_(s) {
  if (!s) return null;
  var m = String(s).slice(0, 10).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

/**
 * Indian fiscal year label for a date. FY runs Apr 1 → Mar 31.
 * e.g. 2025-06-10 → 'FY25-26'; 2026-02-01 → 'FY25-26'; 2026-04-01 → 'FY26-27'.
 */
function fyLabel_(date) {
  var y = date.getFullYear();
  var startYear = (date.getMonth() >= 3) ? y : y - 1; // month 3 = April
  var a = String(startYear % 100);
  var b = String((startYear + 1) % 100);
  return 'FY' + pad2_(a) + '-' + pad2_(b);
}

function pad2_(n) { n = String(n); return n.length < 2 ? '0' + n : n; }

/** Live tab name for a given invoice/credit-note date. */
function liveTabForDate_(date) { return CONFIG.sheet.livePrefix + fyLabel_(date); }

/** Natural key for a sales line. */
function lineKey_(docId, lineId) { return String(docId) + '|' + String(lineId); }

/** Normalise a channel string to canonical GT/MT (or '' if unknown). */
function normalizeChannel_(raw) {
  if (!raw) return CONFIG.channel.defaultWhenUnknown;
  var k = String(raw).trim().toLowerCase();
  if (CONFIG.channel.aliases[k]) return CONFIG.channel.aliases[k];
  var up = String(raw).trim().toUpperCase();
  if (up === 'GT' || up === 'MT') return up;
  return CONFIG.channel.defaultWhenUnknown;
}

/** Expand a GST state code/abbr to a full name; passthrough if already a name. */
function expandState_(codeOrName) {
  if (!codeOrName) return '';
  var key = String(codeOrName).trim().toUpperCase();
  if (CONFIG.state.expandGstCode && GST_STATES[key]) return GST_STATES[key];
  return String(codeOrName).trim();
}

/** Round to 2 decimals for money/percentage columns. */
function round2_(n) { return Math.round((Number(n) || 0) * 100) / 100; }

/** Case-insensitive header lookup helper: returns 1-based column index or 0 if absent. */
function findHeaderIndex_(headerRow, header, aliases) {
  var want = [header].concat(aliases || []).map(function (h) { return String(h).trim().toLowerCase(); });
  for (var i = 0; i < headerRow.length; i++) {
    var h = String(headerRow[i]).trim().toLowerCase();
    if (want.indexOf(h) !== -1) return i + 1;
  }
  return 0;
}

/** Best-effort Date from an arbitrary cell value (used as a last-resort fallback). */
function safeDate_(v) {
  if (v instanceof Date) return v;
  var d = new Date(v);
  return isNaN(d.getTime()) ? null : d;
}

/** A logging helper that also surfaces to the execution transcript. */
function logInfo_(msg) { Logger.log(msg); console.log(msg); }

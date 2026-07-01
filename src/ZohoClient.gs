/**
 * ZohoClient.gs — Zoho Books REST API v3 client (path 2: dedicated Self-Client OAuth).
 *
 * - Refreshes a 1-hour access token from the permanent refresh_token (cached in CacheService).
 * - GETs with exponential backoff + jitter on HTTP 429 (Zoho sends no Retry-After).
 * - Paginated list of invoices / credit notes filtered by last_modified_time.
 * - Per-record detail GET (list endpoints omit line_items — this is unavoidable in Books v3).
 */

/** Get a valid access token, refreshing (and caching) if needed. */
function getAccessToken_() {
  var cache = CacheService.getScriptCache();
  var cached = cache.get('zoho_access_token');
  if (cached) return cached;

  var res = UrlFetchApp.fetch(zohoAccountsBase_() + '/oauth/v2/token', {
    method: 'post',
    payload: {
      grant_type: 'refresh_token',
      client_id: prop_(PROP.CLIENT_ID, true),
      client_secret: prop_(PROP.CLIENT_SECRET, true),
      refresh_token: prop_(PROP.REFRESH_TOKEN, true)
    },
    muteHttpExceptions: true
  });
  var data;
  try { data = JSON.parse(res.getContentText()); } catch (e) { data = {}; }
  if (res.getResponseCode() !== 200 || !data.access_token) {
    throw new Error('Zoho token refresh failed (' + res.getResponseCode() + '): ' + res.getContentText());
  }
  var ttl = Math.max(60, (Number(data.expires_in) || 3600) - 120); // refresh 2 min early
  cache.put('zoho_access_token', data.access_token, Math.min(ttl, 21600));
  return data.access_token;
}

/** Authenticated GET against Books v3 with retries. Returns parsed JSON. */
function zohoGet_(path, params) {
  params = params || {};
  params.organization_id = prop_(PROP.ORG_ID, true);
  var url = zohoApiBase_() + path + '?' + toQuery_(params);
  var token = getAccessToken_();

  for (var attempt = 0; attempt < CONFIG.zoho.maxRetries; attempt++) {
    var res = UrlFetchApp.fetch(url, {
      method: 'get',
      headers: { Authorization: 'Zoho-oauthtoken ' + token },
      muteHttpExceptions: true
    });
    var code = res.getResponseCode();

    if (code === 200) return JSON.parse(res.getContentText());

    if (code === 401) { // token expired mid-run → force refresh once and retry
      CacheService.getScriptCache().remove('zoho_access_token');
      token = getAccessToken_();
      continue;
    }
    if (code === 429 || code >= 500) { // rate-limited or transient → backoff
      Utilities.sleep(backoffMs_(attempt));
      continue;
    }
    throw new Error('Zoho GET ' + path + ' failed (' + code + '): ' + res.getContentText());
  }
  throw new Error('Zoho GET ' + path + ' exhausted ' + CONFIG.zoho.maxRetries + ' retries (rate limited?).');
}

/** GET org id list — handy for setup/verification (see verifyZohoConnection). */
function zohoListOrganizations_() {
  var url = zohoApiBase_() + '/organizations';
  var res = UrlFetchApp.fetch(url, {
    method: 'get',
    headers: { Authorization: 'Zoho-oauthtoken ' + getAccessToken_() },
    muteHttpExceptions: true
  });
  return JSON.parse(res.getContentText());
}

/**
 * List documents ('invoices' | 'creditnotes') modified on/after `sinceDate` (YYYY-MM-DD),
 * paging through all results. Returns the list rows (headers only — no line_items).
 */
function zohoListModified_(module, sinceDate) {
  var out = [];
  var page = 1;
  while (true) {
    var data = zohoGet_('/' + module, {
      last_modified_time: sinceDate,
      per_page: CONFIG.zoho.perPage,
      page: page,
      sort_column: 'last_modified_time',
      sort_order: 'A'
    });
    var rows = data[module] || [];
    out = out.concat(rows);
    var ctx = data.page_context || {};
    if (!ctx.has_more_page) break;
    page++;
  }
  return out;
}

/** Fetch full invoice (with line_items). */
function zohoGetInvoice_(invoiceId) {
  return zohoGet_('/invoices/' + invoiceId, {}).invoice;
}

/** Fetch full credit note (with line_items). */
function zohoGetCreditNote_(creditNoteId) {
  return zohoGet_('/creditnotes/' + creditNoteId, {}).creditnote;
}

/**
 * Discover invoice custom fields so you can set CONFIG.channel.customFieldApiName correctly.
 * Run from the editor; check the execution log for label → api_name pairs.
 */
function listCustomFields() {
  var mods = zohoListModified_('invoices', CONFIG.zoho.backfillStartDate);
  if (!mods.length) { logInfo_('No invoices found since ' + CONFIG.zoho.backfillStartDate); return; }
  var inv = zohoGetInvoice_(mods[0].invoice_id);
  var cf = inv.custom_fields || [];
  if (!cf.length) { logInfo_('Invoice ' + inv.invoice_number + ' has no custom fields.'); return; }
  logInfo_('Custom fields on invoice ' + inv.invoice_number + ':');
  cf.forEach(function (f) { logInfo_('  label="' + f.label + '"  api_name="' + f.api_name + '"  value="' + f.value + '"'); });
}

/**
 * Mapping.gs — turn Zoho documents into canonical Sales Register row objects.
 *
 * A row object is keyed by CONFIG.columns[].field. SheetIO.gs aligns it to the actual
 * sheet columns. All expensive lookups (CP, customer→channel) are built once per run and
 * passed in via a `ctx` object so we don't re-read tabs per line.
 */

/** Build the per-run lookup context (CP index + customer→channel map). */
function buildMappingContext_() {
  return {
    cpIndex: (CONFIG.cp.source === 'product_master') ? buildProductMasterCpIndex_() : {},
    customerChannel: buildCustomerChannelMap_()
  };
}

/**
 * Expand one Zoho invoice into an array of row objects (one per line item).
 * Void/draft invoices never reach here — they are excluded (and their rows deleted) in runSync.
 */
function invoiceToRows_(inv, ctx) {
  var date = parseIsoDate_(inv.date);
  var channel = resolveChannel_(inv, ctx);
  var state = resolveState_(inv);
  var lines = inv.line_items || [];
  var rows = [];

  for (var i = 0; i < lines.length; i++) {
    var li = lines[i];
    var code = li.sku || String(li.item_id || '');
    var qty = Number(li.quantity) || 0;
    var rate = Number(li.rate) || 0;
    var revenue = Number(li.item_total) || 0;
    var cp = lookupCp_(code, channel, ctx);
    var cogs = round2_(qty * cp);
    var profit = round2_(revenue - cogs);
    var marginPct = revenue ? round2_((profit / revenue) * 100) : 0;

    rows.push({
      date: date,
      invoiceNo: inv.invoice_number || '',
      customer: inv.customer_name || '',
      salesperson: inv.salesperson_name || '',
      state: state,
      code: code,
      product: li.name || '',
      qty: qty,
      rate: rate,
      revenue: revenue,
      cp: cp || '',
      cogs: cp ? cogs : '',
      profit: cp ? profit : '',
      marginPct: cp ? marginPct : '',
      channel: channel,             // seed; admin can override during verification
      verified: CONFIG.verifiedNo,
      adminNotes: '',
      key: lineKey_(inv.invoice_id, li.line_item_id),
      zohoStatus: inv.status || '',
      lastModified: inv.last_modified_time || '',
      source: 'invoice',
      _date: date                    // internal: used for FY routing
    });
  }
  return rows;
}

/** Expand one credit note into negative (contra) rows for returns/netting. */
function creditNoteToRows_(cn, ctx) {
  var date = parseIsoDate_(cn.date);
  var channel = resolveChannel_(cn, ctx);
  var state = resolveState_(cn);
  var lines = cn.line_items || [];
  var rows = [];

  for (var i = 0; i < lines.length; i++) {
    var li = lines[i];
    var code = li.sku || String(li.item_id || '');
    var qty = -(Number(li.quantity) || 0);
    var rate = Number(li.rate) || 0;
    var revenue = -(Number(li.item_total) || 0);
    var cp = lookupCp_(code, channel, ctx);
    var cogs = round2_(qty * cp);
    var profit = round2_(revenue - cogs);
    var marginPct = revenue ? round2_((profit / revenue) * 100) : 0;

    rows.push({
      date: date,
      invoiceNo: cn.creditnote_number || '',
      customer: cn.customer_name || '',
      salesperson: cn.salesperson_name || '',
      state: state,
      code: code,
      product: li.name || '',
      qty: qty,
      rate: rate,
      revenue: revenue,
      cp: cp || '',
      cogs: cp ? cogs : '',
      profit: cp ? profit : '',
      marginPct: cp ? marginPct : '',
      channel: channel,
      verified: CONFIG.verifiedNo,
      adminNotes: '',
      key: lineKey_(cn.creditnote_id, li.line_item_id),
      zohoStatus: cn.status || '',
      lastModified: cn.last_modified_time || '',
      source: 'creditnote',
      _date: date
    });
  }
  return rows;
}

// ---- resolvers ----------------------------------------------------------

/** GT/MT: invoice custom field → customer→channel map → blank. */
function resolveChannel_(doc, ctx) {
  var api = CONFIG.channel.customFieldApiName;
  var cfs = doc.custom_fields || [];
  for (var i = 0; i < cfs.length; i++) {
    if (cfs[i].api_name === api && cfs[i].value) return normalizeChannel_(cfs[i].value);
  }
  if (ctx && ctx.customerChannel && doc.customer_id && ctx.customerChannel[doc.customer_id]) {
    return ctx.customerChannel[doc.customer_id];
  }
  return CONFIG.channel.defaultWhenUnknown;
}

/** State from configured source, GST-code expanded. */
function resolveState_(doc) {
  var raw;
  if (CONFIG.state.source === 'shipping') raw = (doc.shipping_address || {}).state;
  else if (CONFIG.state.source === 'billing') raw = (doc.billing_address || {}).state;
  else raw = doc.place_of_supply || (doc.billing_address || {}).state;
  return expandState_(raw);
}

/** CP lookup from the pre-built Product Master index (channel-aware, GT first then MT). */
function lookupCp_(code, channel, ctx) {
  if (CONFIG.cp.source !== 'product_master') return 0;
  var idx = ctx.cpIndex || {};
  var key = String(code).trim().toUpperCase();
  if (channel === 'MT' && idx['MT|' + key] != null) return idx['MT|' + key];
  if (channel === 'GT' && idx['GT|' + key] != null) return idx['GT|' + key];
  // channel unknown → try either
  if (idx['GT|' + key] != null) return idx['GT|' + key];
  if (idx['MT|' + key] != null) return idx['MT|' + key];
  return 0;
}

// ---- index builders (read tabs once) -----------------------------------

/** Read Product Master_GT/MT → { 'GT|CODE': cp, 'MT|CODE': cp }. */
function buildProductMasterCpIndex_() {
  var idx = {};
  [['GT', CONFIG.sheet.productMasterGT], ['MT', CONFIG.sheet.productMasterMT]].forEach(function (pair) {
    var ch = pair[0], tabName = pair[1];
    var sh = getSpreadsheet_().getSheetByName(tabName);
    if (!sh) return;
    var values = sh.getDataRange().getValues();
    if (values.length < 2) return;
    var header = values[0];
    var codeCol = findHeaderIndex_(header, CONFIG.cp.codeHeaderAliases[0], CONFIG.cp.codeHeaderAliases.slice(1));
    var costCol = findHeaderIndex_(header, CONFIG.cp.costHeaderAliases[0], CONFIG.cp.costHeaderAliases.slice(1));
    if (!codeCol || !costCol) {
      logInfo_('Product Master "' + tabName + '": could not find code/cost columns; CP lookup skipped for ' + ch);
      return;
    }
    for (var r = 1; r < values.length; r++) {
      var code = String(values[r][codeCol - 1]).trim().toUpperCase();
      if (!code) continue;
      var cp = Number(String(values[r][costCol - 1]).replace(/[^0-9.\-]/g, '')) || 0;
      idx[ch + '|' + code] = cp;
    }
  });
  return idx;
}

/** Read optional Customer Channel Map tab → { customer_id: 'GT'|'MT' }. */
function buildCustomerChannelMap_() {
  var map = {};
  var sh = getSpreadsheet_().getSheetByName(CONFIG.sheet.customerChannelTab);
  if (!sh) return map;
  var values = sh.getDataRange().getValues();
  if (values.length < 2) return map;
  var header = values[0];
  var idCol = findHeaderIndex_(header, 'Customer ID', ['customer_id', 'id']);
  var chCol = findHeaderIndex_(header, 'Channel', ['channel mode', 'gt/mt']);
  if (!idCol || !chCol) return map;
  for (var r = 1; r < values.length; r++) {
    var id = String(values[r][idCol - 1]).trim();
    var ch = normalizeChannel_(values[r][chCol - 1]);
    if (id && ch) map[id] = ch;
  }
  return map;
}

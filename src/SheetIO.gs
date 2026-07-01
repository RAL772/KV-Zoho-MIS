/**
 * SheetIO.gs — all Google Sheet reads/writes (direct-to-live model).
 *
 * Guarantees:
 *  - Writes are values-only (setValues) → tab names & gids the dashboard depends on never change.
 *  - The sync writes NEW rows straight into their live FY tab each run (no per-run gate).
 *  - "Specified fields" (CONFIG.preserveOnUpdate): on an EXISTING row the sync never overwrites a
 *    NON-EMPTY value there, so manual admin edits (GT/MT channel, Verified, notes) survive forever.
 *    A still-blank specified field may be filled by the auto-resolver; a human value is never touched.
 *  - Live tabs are matched by header NAME (any column order); a _Key column is required for upsert.
 */

function getSpreadsheet_() {
  var id = CONFIG.sheet.spreadsheetId || prop_(PROP.SPREADSHEET_ID, false);
  if (id) return SpreadsheetApp.openById(id);
  var active = SpreadsheetApp.getActiveSpreadsheet();
  if (!active) throw new Error('No spreadsheet id set and script is not bound. Set CONFIG.sheet.spreadsheetId or Script Property SPREADSHEET_ID.');
  return active;
}

/** field → 1-based column index for a sheet, matched by header/alias. Missing fields omitted. */
function columnMapForSheet_(sheet) {
  var lastCol = sheet.getLastColumn();
  if (lastCol < 1) return { header: [], map: {} };
  var header = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  var map = {};
  CONFIG.columns.forEach(function (c) {
    var idx = findHeaderIndex_(header, c.header, c.aliases);
    if (idx) map[c.field] = idx;
  });
  return { header: header, map: map };
}

/** The fields the sync must not overwrite once a human has set them (see CONFIG.preserveOnUpdate). */
function preserveFields_() {
  if (CONFIG.preserveOnUpdate && CONFIG.preserveOnUpdate.length) return CONFIG.preserveOnUpdate;
  return CONFIG.columns.filter(function (c) { return c.owner === 'admin'; }).map(function (c) { return c.field; });
}

/**
 * Upsert canonical rows directly into their live FY tabs (routed by invoice/credit-note date).
 * Returns { inserted, updated, tabs:{ tab:{inserted,updated} } }.
 */
function writeRowsToLive_(rows) {
  var byTab = {};
  rows.forEach(function (row) {
    var d = (row._date instanceof Date) ? row._date : parseIsoDate_(row.date);
    if (!d) return;
    var tab = liveTabForDate_(d);
    (byTab[tab] = byTab[tab] || []).push(row);
  });

  var summary = { inserted: 0, updated: 0, tabs: {} };
  Object.keys(byTab).forEach(function (tab) {
    var r = upsertLive_(tab, byTab[tab]);
    summary.inserted += r.inserted;
    summary.updated += r.updated;
    summary.tabs[tab] = r;
  });
  return summary;
}

/** Upsert rows into ONE live FY tab. Preserves non-empty specified fields on existing rows. */
function upsertLive_(tabName, rows) {
  var sh = ensureFyTab_(tabName);
  var cm = columnMapForSheet_(sh);
  if (!cm.map.key) throw new Error('Live tab "' + tabName + '" has no _Key column; add it so the sync can upsert without duplicating rows.');
  var lastCol = sh.getLastColumn();
  var existing = readKeyRowIndex_(sh, cm.map.key);
  var appends = [];
  var updated = 0;

  rows.forEach(function (row) {
    var rowNum = existing[row.key];
    if (rowNum) {
      var current = sh.getRange(rowNum, 1, 1, lastCol).getValues()[0];
      var merged = buildRowArray_(cm, row, current);   // preserves non-empty specified fields
      sh.getRange(rowNum, 1, 1, lastCol).setValues([merged]);
      updated++;
    } else {
      appends.push(buildRowArray_(cm, row, null));      // new row: seed channel + Verified=No
    }
  });
  if (appends.length) sh.getRange(sh.getLastRow() + 1, 1, appends.length, lastCol).setValues(appends);
  return { inserted: appends.length, updated: updated };
}

/** Get a live FY tab, auto-creating it (headers cloned from the newest live tab) if configured. */
function ensureFyTab_(tabName) {
  var ss = getSpreadsheet_();
  var sh = ss.getSheetByName(tabName);
  if (sh) return sh;
  if (!CONFIG.sheet.autoCreateFyTab) {
    throw new Error('Live tab "' + tabName + '" does not exist. Create it (exact name, additively) or set CONFIG.sheet.autoCreateFyTab = true.');
  }
  var template = latestLiveTab_(ss);
  if (!template) throw new Error('Cannot auto-create "' + tabName + '": no existing live tab to copy headers from. Create the first FY tab manually.');
  sh = ss.insertSheet(tabName);
  var nCols = template.getLastColumn();
  sh.getRange(1, 1, 1, nCols).setValues(template.getRange(1, 1, 1, nCols).getValues()).setFontWeight('bold');
  sh.setFrozenRows(1);
  logInfo_('Auto-created live tab "' + tabName + '" (headers cloned from "' + template.getName() + '"). Run setupProtections() to protect its tag columns.');
  return sh;
}

/** Newest existing live FY tab (max name), used as a header template for auto-create. */
function latestLiveTab_(ss) {
  var live = ss.getSheets().filter(function (s) { return s.getName().indexOf(CONFIG.sheet.livePrefix) === 0; });
  if (!live.length) return null;
  live.sort(function (a, b) { return a.getName() < b.getName() ? 1 : -1; });
  return live[0];
}

/** key → { sheet, cm, rowNum } across all live FY tabs (for tag import / lookups). */
function buildLiveKeyLocator_() {
  var ss = getSpreadsheet_();
  var loc = {};
  ss.getSheets().forEach(function (sh) {
    if (sh.getName().indexOf(CONFIG.sheet.livePrefix) !== 0) return;
    if (sh.getLastRow() < 2) return;
    var cm = columnMapForSheet_(sh);
    if (!cm.map.key) return;
    var keys = sh.getRange(2, cm.map.key, sh.getLastRow() - 1, 1).getValues();
    for (var i = 0; i < keys.length; i++) {
      var k = String(keys[i][0]).trim();
      if (k && !loc[k]) loc[k] = { sheet: sh, cm: cm, rowNum: i + 2 };
    }
  });
  return loc;
}

// ---- helpers ------------------------------------------------------------

/**
 * Build a full-width row array for a sheet from a canonical row object.
 * If `current` is provided (existing row), NON-EMPTY values in specified fields are kept as-is;
 * a blank specified field is allowed to be filled by the sync. New rows (current=null) get all fields.
 */
function buildRowArray_(cm, row, current) {
  var lastCol = cm.header.length;
  var arr = current ? current.slice() : new Array(lastCol).fill('');
  var preserve = {};
  preserveFields_().forEach(function (f) { preserve[f] = true; });

  CONFIG.columns.forEach(function (c) {
    var idx = cm.map[c.field];
    if (!idx) return;
    if (current && preserve[c.field]) {
      var cur = current[idx - 1];
      if (cur !== '' && cur !== null && cur !== undefined) return; // keep the human's value — sacred
    }
    arr[idx - 1] = formatValue_(c, row[c.field]);
  });
  return arr;
}

/** Convert a sheet row array back into a canonical row object using the column map. */
function arrayToRowObject_(cm, arr) {
  var obj = {};
  CONFIG.columns.forEach(function (c) {
    var idx = cm.map[c.field];
    obj[c.field] = idx ? arr[idx - 1] : '';
  });
  return obj;
}

/** key → 1-based sheet row number, for the given key column. */
function readKeyRowIndex_(sheet, keyCol) {
  var map = {};
  var last = sheet.getLastRow();
  if (last < 2) return map;
  var keys = sheet.getRange(2, keyCol, last - 1, 1).getValues();
  for (var i = 0; i < keys.length; i++) {
    var k = String(keys[i][0]).trim();
    if (k) map[k] = i + 2;
  }
  return map;
}

/** Type/format a value for writing per the column config. */
function formatValue_(col, val) {
  if (val === '' || val === null || val === undefined) return '';
  if (col.type === 'date') {
    var d = (val instanceof Date) ? val : parseIsoDate_(val);
    if (!d) return '';
    return (CONFIG.format.dates === 'string') ? Utilities.formatDate(d, CONFIG.zoho.dc === 'in' ? 'Asia/Kolkata' : 'UTC', 'd-MMM-yy') : d;
  }
  if (col.type === 'number') {
    var n = Number(val);
    return isNaN(n) ? '' : n;
  }
  return val;
}

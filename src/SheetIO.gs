/**
 * SheetIO.gs — all Google Sheet reads/writes.
 *
 * Design guarantees:
 *  - Writes are values-only (setValues) → tab names & gids the dashboard depends on never change.
 *  - Admin-owned columns (owner:'admin') are NEVER overwritten on rows that already exist.
 *  - Live tabs are matched by header NAME (any column order); staging is created in canonical order.
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

/** Create the staging tab with the full canonical header row if it doesn't exist. */
function ensureStagingSheet_() {
  var ss = getSpreadsheet_();
  var sh = ss.getSheetByName(CONFIG.sheet.stagingTab);
  if (!sh) {
    sh = ss.insertSheet(CONFIG.sheet.stagingTab);
    var headers = CONFIG.columns.map(function (c) { return c.header; });
    sh.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  return sh;
}

/**
 * Upsert canonical row objects into the STAGING tab, keyed by `_Key`.
 * Carry-forward: if a key already exists on a live FY tab, seed the staging row's admin columns
 * (channel / notes) from the live row so the admin isn't re-tagging from scratch.
 */
function writeRowsToStaging_(rows) {
  if (!rows.length) return { inserted: 0, updated: 0 };
  var sh = ensureStagingSheet_();
  var cm = columnMapForSheet_(sh);
  var keyCol = cm.map.key;
  if (!keyCol) throw new Error('Staging tab is missing the _Key column.');

  var liveTags = buildLiveTagIndex_();                 // key → { channel, adminNotes }
  var existing = readKeyRowIndex_(sh, keyCol);         // key → sheet row number
  var lastCol = sh.getLastColumn();

  var appends = [];
  var updated = 0;

  rows.forEach(function (row) {
    // seed admin columns from an already-promoted live row, if present
    var carried = liveTags[row.key];
    if (carried) {
      if (carried.channel) row.channel = carried.channel;
      if (carried.adminNotes) row.adminNotes = carried.adminNotes;
    }
    var rowNum = existing[row.key];
    if (rowNum) {
      // update SYNC-owned cells only; leave admin cells (channel/verified/notes) as the admin left them
      var current = sh.getRange(rowNum, 1, 1, lastCol).getValues()[0];
      var merged = buildRowArray_(cm, row, current, /*preserveAdmin=*/true);
      sh.getRange(rowNum, 1, 1, lastCol).setValues([merged]);
      updated++;
    } else {
      appends.push(buildRowArray_(cm, row, null, /*preserveAdmin=*/false));
    }
  });

  if (appends.length) {
    sh.getRange(sh.getLastRow() + 1, 1, appends.length, lastCol).setValues(appends);
  }
  return { inserted: appends.length, updated: updated };
}

/**
 * Promote all rows on staging whose Verified === Yes into their live FY tab, then remove them
 * from staging. Upsert on live is tag-preserving. Returns a summary.
 */
function promoteVerifiedRows_() {
  var ss = getSpreadsheet_();
  var sh = ss.getSheetByName(CONFIG.sheet.stagingTab);
  if (!sh || sh.getLastRow() < 2) return { promoted: 0, tabs: {} };

  var cm = columnMapForSheet_(sh);
  var lastCol = sh.getLastColumn();
  var values = sh.getRange(2, 1, sh.getLastRow() - 1, lastCol).getValues();

  var verCol = cm.map.verified, keyCol = cm.map.key, dateCol = cm.map.date;
  if (!verCol || !keyCol || !dateCol) throw new Error('Staging tab missing Verified / _Key / Date column.');

  var promoteRowNums = [];
  var byTab = {};   // tabName → array of canonical row objects
  var summary = { promoted: 0, tabs: {} };

  for (var i = 0; i < values.length; i++) {
    var v = values[i];
    var ver = String(v[verCol - 1]).trim().toLowerCase();
    if (ver !== CONFIG.verifiedYes.toLowerCase() && ver !== 'yes' && ver !== 'y' && ver !== 'true') continue;

    var obj = arrayToRowObject_(cm, v);
    var d = (obj.date instanceof Date) ? obj.date : (parseIsoDate_(obj.date) || safeDate_(obj.date));
    if (!d || isNaN(d.getTime())) continue;
    var tab = liveTabForDate_(d);
    (byTab[tab] = byTab[tab] || []).push(obj);
    promoteRowNums.push(i + 2); // sheet row number
  }

  Object.keys(byTab).forEach(function (tab) {
    var n = upsertLive_(tab, byTab[tab]);
    summary.tabs[tab] = n;
    summary.promoted += n;
  });

  // delete promoted rows from staging (bottom-up to keep indices valid)
  promoteRowNums.sort(function (a, b) { return b - a; });
  promoteRowNums.forEach(function (rn) { sh.deleteRow(rn); });

  return summary;
}

/** Upsert canonical row objects into a live FY tab (must already exist). Tag columns preserved. */
function upsertLive_(tabName, rows) {
  var ss = getSpreadsheet_();
  var sh = ss.getSheetByName(tabName);
  if (!sh) {
    throw new Error('Live tab "' + tabName + '" does not exist. Create it (additively, exact name) before promoting rows for that FY.');
  }
  var cm = columnMapForSheet_(sh);
  if (!cm.map.key) throw new Error('Live tab "' + tabName + '" has no _Key column; add it so promotion can upsert without duplicates.');
  var lastCol = sh.getLastColumn();
  var existing = readKeyRowIndex_(sh, cm.map.key);
  var appends = [];

  rows.forEach(function (row) {
    var rowNum = existing[row.key];
    if (rowNum) {
      var current = sh.getRange(rowNum, 1, 1, lastCol).getValues()[0];
      // on live, the admin columns ARE authoritative (they were verified) → write them through,
      // but keep any existing admin note the admin may have added directly on the live tab.
      var merged = buildRowArray_(cm, row, current, /*preserveAdmin=*/false);
      sh.getRange(rowNum, 1, 1, lastCol).setValues([merged]);
    } else {
      appends.push(buildRowArray_(cm, row, null, false));
    }
  });
  if (appends.length) sh.getRange(sh.getLastRow() + 1, 1, appends.length, lastCol).setValues(appends);
  return rows.length;
}

// ---- helpers ------------------------------------------------------------

/** Build a full-width row array for a sheet from a canonical row object.
 *  preserveAdmin=true keeps the sheet's current admin-owned cell values. */
function buildRowArray_(cm, row, current, preserveAdmin) {
  var lastCol = cm.header.length;
  var arr = current ? current.slice() : new Array(lastCol).fill('');
  CONFIG.columns.forEach(function (c) {
    var idx = cm.map[c.field];
    if (!idx) return;
    if (c.owner === 'admin' && preserveAdmin && current) return; // don't clobber admin edits
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

/** Build key → { channel, adminNotes } across all live FY tabs (for carry-forward). */
function buildLiveTagIndex_() {
  var ss = getSpreadsheet_();
  var idx = {};
  ss.getSheets().forEach(function (sh) {
    var name = sh.getName();
    if (name.indexOf(CONFIG.sheet.livePrefix) !== 0) return;   // only live FY tabs
    if (name === CONFIG.sheet.stagingTab) return;
    if (sh.getLastRow() < 2) return;
    var cm = columnMapForSheet_(sh);
    if (!cm.map.key) return;
    var lastCol = sh.getLastColumn();
    var values = sh.getRange(2, 1, sh.getLastRow() - 1, lastCol).getValues();
    var kC = cm.map.key, chC = cm.map.channel, noC = cm.map.adminNotes;
    for (var r = 0; r < values.length; r++) {
      var k = String(values[r][kC - 1]).trim();
      if (!k) continue;
      idx[k] = {
        channel: chC ? values[r][chC - 1] : '',
        adminNotes: noC ? values[r][noC - 1] : ''
      };
    }
  });
  return idx;
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

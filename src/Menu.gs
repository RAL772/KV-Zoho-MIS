/**
 * Menu.gs — admin UI (custom menu), trigger management, and the Excel export/import loop.
 * Works when the script is BOUND to the spreadsheet (recommended). If standalone, run these
 * functions from the Apps Script editor instead.
 */

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('KV Sync')
    .addItem('Sync now (Zoho → Live)', 'menuSyncNow')
    .addItem('Weekly review summary', 'menuReview')
    .addSeparator()
    .addItem('Export a tab to Excel…', 'menuExportTab')
    .addItem('Import tags from a tab…', 'menuImportTags')
    .addSeparator()
    .addItem('Set up admin-only protections', 'setupProtections')
    .addSubMenu(SpreadsheetApp.getUi().createMenu('Schedule')
      .addItem('Install DAILY trigger', 'installDailyTrigger')
      .addItem('Install HOURLY trigger', 'installHourlyTrigger')
      .addItem('Remove all triggers', 'removeSyncTriggers'))
    .addSeparator()
    .addItem('Verify Zoho connection', 'menuVerifyZoho')
    .addItem('List invoice custom fields', 'listCustomFields')
    .addToUi();
}

function menuSyncNow() {
  var res = runSync();
  toast_(res ? ('Sync done: ' + res.inserted + ' new, ' + res.updated + ' updated in live tabs') : 'Sync done: no changes');
}

function menuReview() {
  var s = reviewSummary();
  var parts = Object.keys(s.tabs).map(function (t) {
    return '  ' + t + ': ' + s.tabs[t].needsTag + ' untagged, ' + s.tabs[t].unverified + ' unverified';
  });
  alert_('Weekly review — rows needing attention:\n' + (parts.join('\n') || '  (none)') +
         '\n\nTOTAL: ' + s.totalNeedsTag + ' untagged, ' + s.totalUnverified + ' unverified.\n' +
         'Fill the blank Channel mode cells and set Verified = Yes on the live tabs; the sync preserves them.');
}

function menuVerifyZoho() { verifyZohoConnection(); alert_('Zoho check complete — see Executions log for org details.'); }

// ---- triggers -----------------------------------------------------------

function installDailyTrigger() { installTrigger_('daily'); }
function installHourlyTrigger() { installTrigger_('hourly'); }

function installTrigger_(kind) {
  removeSyncTriggers();
  var b = ScriptApp.newTrigger('runSync').timeBased();
  if (kind === 'hourly') b.everyHours(1).create();
  else b.everyDays(1).atHour(2).create();   // ~02:00 IST daily; adjust as needed
  alert_('Installed ' + kind + ' trigger for runSync.');
}

function removeSyncTriggers() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'runSync') ScriptApp.deleteTrigger(t);
  });
}

// ---- Excel export / import loop (weekly review, offline) ----------------

/**
 * Export a tab as .xlsx into Drive and return/log the file URL. Admin edits the specified fields
 * (Channel mode / Verified / Admin Notes) offline, then re-imports (see importTagsFromTab).
 */
function exportTabToExcel(tabName) {
  var ss = getSpreadsheet_();
  var sh = ss.getSheetByName(tabName);
  if (!sh) throw new Error('No such tab: "' + tabName + '".');
  var url = 'https://docs.google.com/spreadsheets/d/' + ss.getId() + '/export?format=xlsx&gid=' + sh.getSheetId();
  var blob = UrlFetchApp.fetch(url, { headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() } })
    .getBlob().setName(tabName + '_' + nowStamp_() + '.xlsx');
  var file = DriveApp.createFile(blob);
  logInfo_('Exported "' + tabName + '": ' + file.getUrl());
  return file.getUrl();
}

function menuExportTab() {
  var ui = SpreadsheetApp.getUi();
  var active = SpreadsheetApp.getActiveSheet().getName();
  var resp = ui.prompt('Export to Excel', 'Tab name to export (default: "' + active + '"):', ui.ButtonSet.OK_CANCEL);
  if (resp.getSelectedButton() !== ui.Button.OK) return;
  var name = resp.getResponseText().trim() || active;
  var link = exportTabToExcel(name);
  alert_('Exported to Drive:\n' + link + '\n\nEdit the specified fields there, then Import tags from a tab.');
}

/**
 * Import edited tags back into the live tabs from another tab in THIS spreadsheet.
 * Paste your edited rows (must include the _Key column + any specified field) into a tab, then run
 * this and give its name. Matches by _Key across all live FY tabs; ONLY the specified fields are
 * copied — data columns are untouched. (This is an explicit admin action, so it DOES overwrite the
 * specified fields with your imported values.)
 */
function importTagsFromTab(tabName) {
  var ss = getSpreadsheet_();
  var src = ss.getSheetByName(tabName);
  if (!src) throw new Error('Source tab "' + tabName + '" not found.');
  var srcCm = columnMapForSheet_(src);
  if (!srcCm.map.key) throw new Error('Source tab "' + tabName + '" needs a _Key column.');

  var srcVals = src.getDataRange().getValues();
  var locator = buildLiveKeyLocator_();
  var fields = preserveFields_();
  var updated = 0, skipped = 0;

  for (var r = 1; r < srcVals.length; r++) {
    var key = String(srcVals[r][srcCm.map.key - 1]).trim();
    if (!key) continue;
    var loc = locator[key];
    if (!loc) { skipped++; continue; }
    fields.forEach(function (f) {
      var sCol = srcCm.map[f], dCol = loc.cm.map[f];
      if (!sCol || !dCol) return;
      var val = srcVals[r][sCol - 1];
      if (f === 'channel') val = normalizeChannel_(val) || val;
      loc.sheet.getRange(loc.rowNum, dCol).setValue(val);
    });
    updated++;
  }
  logInfo_('Imported tags for ' + updated + ' live row(s) from "' + tabName + '" (' + skipped + ' keys not found).');
  return updated;
}

function menuImportTags() {
  var ui = SpreadsheetApp.getUi();
  var resp = ui.prompt('Import tags', 'Name of the tab holding your edited rows (with _Key):', ui.ButtonSet.OK_CANCEL);
  if (resp.getSelectedButton() !== ui.Button.OK) return;
  var n = importTagsFromTab(resp.getResponseText().trim());
  alert_('Imported tags into ' + n + ' live row(s).');
}

// ---- tiny UI helpers ----------------------------------------------------

function toast_(msg) { try { SpreadsheetApp.getActiveSpreadsheet().toast(msg, 'KV Sync', 6); } catch (e) { logInfo_(msg); } }
function alert_(msg) { try { SpreadsheetApp.getUi().alert(msg); } catch (e) { logInfo_(msg); } }
function nowStamp_() { return Utilities.formatDate(new Date(), 'Asia/Kolkata', 'yyyyMMdd-HHmm'); }

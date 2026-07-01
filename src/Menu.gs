/**
 * Menu.gs — admin UI (custom menu), trigger management, and the Excel export/import loop.
 * Works when the script is BOUND to the spreadsheet (recommended). If standalone, run these
 * functions from the Apps Script editor instead.
 */

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('KV Sync')
    .addItem('Sync now (Zoho → Staging)', 'menuSyncNow')
    .addItem('Promote verified rows → Live', 'menuPromote')
    .addSeparator()
    .addItem('Export Staging to Excel', 'menuExportStaging')
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
  toast_('Sync done: ' + (res ? res.inserted + ' new, ' + res.updated + ' updated in Staging' : 'no changes'));
}

function menuPromote() {
  var s = promoteVerifiedRows_();
  var parts = Object.keys(s.tabs).map(function (t) { return t + ': ' + s.tabs[t]; });
  alert_('Promoted ' + s.promoted + ' verified row(s).\n' + (parts.join('\n') || '(none)'));
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

// ---- Excel export / import loop ----------------------------------------

/**
 * Export the Staging tab as an .xlsx into Drive and return/log the file URL.
 * Admin edits Channel mode / Verified / Admin Notes offline, then re-imports (see menuImportTags).
 */
function exportStagingToExcel() {
  var ss = getSpreadsheet_();
  var sh = ss.getSheetByName(CONFIG.sheet.stagingTab);
  if (!sh) throw new Error('No staging tab to export.');
  var url = 'https://docs.google.com/spreadsheets/d/' + ss.getId() + '/export?format=xlsx&gid=' + sh.getSheetId();
  var blob = UrlFetchApp.fetch(url, {
    headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() }
  }).getBlob().setName(CONFIG.sheet.stagingTab + '_' + nowStamp_() + '.xlsx');
  var file = DriveApp.createFile(blob);
  logInfo_('Staging exported: ' + file.getUrl());
  return file.getUrl();
}

function menuExportStaging() {
  var link = exportStagingToExcel();
  alert_('Staging exported to Drive:\n' + link + '\n\nEdit Channel mode / Verified there, then re-import.');
}

/**
 * Import edited tags back into Staging from another tab in THIS spreadsheet.
 * Paste your edited rows (must include the _Key column + any of Channel mode / Verified /
 * Admin Notes) into a tab, then run this and give its name. Matches by _Key; only tag columns
 * are copied — data columns are untouched.
 */
function importTagsFromTab(tabName) {
  var ss = getSpreadsheet_();
  var src = ss.getSheetByName(tabName);
  var stg = ss.getSheetByName(CONFIG.sheet.stagingTab);
  if (!src || !stg) throw new Error('Source tab or staging tab not found.');

  var srcCm = columnMapForSheet_(src);
  var stgCm = columnMapForSheet_(stg);
  if (!srcCm.map.key) throw new Error('Source tab "' + tabName + '" needs a _Key column.');

  var srcVals = src.getDataRange().getValues();
  var stgIndex = readKeyRowIndex_(stg, stgCm.map.key);
  var adminFields = ['channel', 'verified', 'adminNotes'];
  var updated = 0;

  for (var r = 1; r < srcVals.length; r++) {
    var key = String(srcVals[r][srcCm.map.key - 1]).trim();
    if (!key || !stgIndex[key]) continue;
    var stgRow = stgIndex[key];
    adminFields.forEach(function (f) {
      var sCol = srcCm.map[f], dCol = stgCm.map[f];
      if (!sCol || !dCol) return;
      var val = srcVals[r][sCol - 1];
      if (f === 'channel') val = normalizeChannel_(val) || val;
      stg.getRange(stgRow, dCol).setValue(val);
    });
    updated++;
  }
  logInfo_('Imported tags for ' + updated + ' staged row(s) from "' + tabName + '".');
  return updated;
}

function menuImportTags() {
  var ui = SpreadsheetApp.getUi();
  var resp = ui.prompt('Import tags', 'Name of the tab holding your edited rows (with _Key):', ui.ButtonSet.OK_CANCEL);
  if (resp.getSelectedButton() !== ui.Button.OK) return;
  var n = importTagsFromTab(resp.getResponseText().trim());
  alert_('Imported tags for ' + n + ' row(s). Review Verified, then Promote.');
}

// ---- tiny UI helpers ----------------------------------------------------

function toast_(msg) { try { SpreadsheetApp.getActiveSpreadsheet().toast(msg, 'KV Sync', 6); } catch (e) { logInfo_(msg); } }
function alert_(msg) { try { SpreadsheetApp.getUi().alert(msg); } catch (e) { logInfo_(msg); } }
function nowStamp_() { return Utilities.formatDate(new Date(), 'Asia/Kolkata', 'yyyyMMdd-HHmm'); }

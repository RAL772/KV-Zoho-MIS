/**
 * Protect.gs — make the admin-owned (tag) columns editable ONLY by admins.
 *
 * Protected ranges restrict who can edit a range; the sheet owner is always allowed (so the
 * automation, which runs as the owner, can still write tags through). Everyone else is blocked
 * from the Channel mode / Verified / Admin Notes columns. Run setupProtections() once (and again
 * after adding a new FY tab).
 */

var PROTECT_TAG = 'KV-ZOHO-SYNC admin-only tag column';

/** Protect admin-owned columns on the staging tab and every live FY tab. */
function setupProtections() {
  var ss = getSpreadsheet_();
  var adminCols = CONFIG.columns.filter(function (c) { return c.owner === 'admin'; });
  var targets = [ss.getSheetByName(CONFIG.sheet.stagingTab)].filter(Boolean);
  ss.getSheets().forEach(function (sh) {
    var name = sh.getName();
    if (name === CONFIG.sheet.stagingTab) return;              // already added; avoid double-protect
    if (name.indexOf(CONFIG.sheet.livePrefix) === 0) targets.push(sh);
  });

  var count = 0;
  targets.forEach(function (sh) {
    clearOurProtections_(sh);
    var cm = columnMapForSheet_(sh);
    adminCols.forEach(function (c) {
      var col = cm.map[c.field];
      if (!col) return;
      var rng = sh.getRange(1, col, sh.getMaxRows(), 1);
      var p = rng.protect().setDescription(PROTECT_TAG + ' (' + c.header + ')');
      // remove all other editors; keep only configured admins (+ owner, always retained)
      var editors = p.getEditors().map(function (u) { return u.getEmail(); });
      if (editors.length) p.removeEditors(editors);
      if (CONFIG.admin.editors && CONFIG.admin.editors.length) p.addEditors(CONFIG.admin.editors);
      p.setDomainEdit(false);
      count++;
    });
  });
  logInfo_('Protected ' + count + ' admin-only tag column(s) across ' + targets.length + ' tab(s).');
}

/** Remove protections previously created by this script (so re-runs don't stack). */
function clearOurProtections_(sh) {
  var prots = sh.getProtections(SpreadsheetApp.ProtectionType.RANGE);
  prots.forEach(function (p) {
    if (p.getDescription() && p.getDescription().indexOf(PROTECT_TAG) === 0) p.remove();
  });
}

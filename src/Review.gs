/**
 * Review.gs — weekly (non-blocking) review helpers.
 *
 * The sync writes straight to the live FY tabs, so there is NO promote step. Instead, once a week
 * an admin scans rows that still need a manual tag (blank Channel mode) or aren't signed off
 * (Verified ≠ Yes), fills them in on the live tab, and marks Verified = Yes. Those edits are then
 * preserved by every future sync (see CONFIG.preserveOnUpdate).
 */

/** Log a per-FY-tab summary of rows needing attention. Returns the summary object. */
function reviewSummary() {
  var ss = getSpreadsheet_();
  var out = { totalNeedsTag: 0, totalUnverified: 0, tabs: {} };

  ss.getSheets().forEach(function (sh) {
    var name = sh.getName();
    if (name.indexOf(CONFIG.sheet.livePrefix) !== 0) return;
    if (sh.getLastRow() < 2) return;
    var cm = columnMapForSheet_(sh);
    var lastCol = sh.getLastColumn();
    var vals = sh.getRange(2, 1, sh.getLastRow() - 1, lastCol).getValues();
    var chC = cm.map.channel, verC = cm.map.verified;
    var needsTag = 0, unverified = 0;

    for (var r = 0; r < vals.length; r++) {
      if (chC && String(vals[r][chC - 1]).trim() === '') needsTag++;
      if (verC && String(vals[r][verC - 1]).trim().toLowerCase() !== CONFIG.verifiedYes.toLowerCase()) unverified++;
    }
    out.tabs[name] = { needsTag: needsTag, unverified: unverified, rows: vals.length };
    out.totalNeedsTag += needsTag;
    out.totalUnverified += unverified;
  });

  var lines = Object.keys(out.tabs).map(function (t) {
    var s = out.tabs[t];
    return '  ' + t + ': ' + s.needsTag + ' need GT/MT tag, ' + s.unverified + ' unverified (of ' + s.rows + ')';
  });
  logInfo_('Weekly review — rows needing attention:\n' + (lines.join('\n') || '  (none)') +
           '\nTOTAL: ' + out.totalNeedsTag + ' untagged, ' + out.totalUnverified + ' unverified.');
  return out;
}

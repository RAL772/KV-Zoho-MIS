/**
 * Promote.gs — public entry point to move admin-verified staged rows into their live FY tab.
 * The real work is in SheetIO.promoteVerifiedRows_(); this wrapper is for running from the editor
 * and for logging a summary.
 */

function promoteVerified() {
  var s = promoteVerifiedRows_();
  var parts = Object.keys(s.tabs).map(function (t) { return '  ' + t + ': ' + s.tabs[t]; });
  logInfo_('Promoted ' + s.promoted + ' verified row(s):\n' + (parts.join('\n') || '  (none)'));
  return s;
}

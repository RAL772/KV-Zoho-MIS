/**
 * Sync.gs — the orchestrator run by the time-driven trigger (and the "Sync now" menu item).
 *
 * Flow: read checkpoint → list invoices/credit-notes modified since it → detail-GET each for
 * line items → map to rows → upsert DIRECTLY into the live FY tabs → advance checkpoint.
 * New rows appear immediately (Verified=No); manual "specified fields" on existing rows are never
 * overwritten (see SheetIO / CONFIG.preserveOnUpdate). Admins review weekly (Review.gs).
 */

/** Main entry point (trigger target). */
function runSync() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) { logInfo_('Another sync is running; skipping.'); return; }
  try {
    var since = getCheckpoint_();
    logInfo_('Sync start. Fetching documents modified on/after ' + since + ' …');
    var ctx = buildMappingContext_();

    var allRows = [];
    var maxModified = since;

    var floor = CONFIG.zoho.backfillStartDate; // forward-only: ignore invoices dated before this

    // ---- invoices ----
    var invHeaders = zohoListModified_('invoices', since).filter(function (h) {
      return String(h.date) >= floor;         // client-side floor (also guards if server filter is ignored)
    });
    logInfo_('Invoices changed (in scope): ' + invHeaders.length);
    invHeaders.forEach(function (h) {
      var inv = zohoGetInvoice_(h.invoice_id);   // list omits line_items → detail GET required
      allRows = allRows.concat(invoiceToRows_(inv, ctx));
      maxModified = maxIso_(maxModified, inv.last_modified_time);
    });

    // ---- credit notes (returns) ----
    if (CONFIG.zoho.fetchCreditNotes) {
      var cnHeaders = zohoListModified_('creditnotes', since).filter(function (h) {
        return String(h.date) >= floor;
      });
      logInfo_('Credit notes changed (in scope): ' + cnHeaders.length);
      cnHeaders.forEach(function (h) {
        var cn = zohoGetCreditNote_(h.creditnote_id);
        allRows = allRows.concat(creditNoteToRows_(cn, ctx));
        maxModified = maxIso_(maxModified, cn.last_modified_time);
      });
    }

    var res = writeRowsToLive_(allRows);
    logInfo_('Live upsert: ' + res.inserted + ' new, ' + res.updated + ' updated (' + allRows.length + ' line rows across ' + Object.keys(res.tabs).length + ' FY tab(s)). Manual tags on existing rows were preserved.');

    // advance checkpoint to the date of the newest modification we saw (idempotent upsert covers overlaps)
    setCheckpoint_(isoDateOnly_(maxModified));
    logInfo_('Checkpoint advanced to ' + getCheckpoint_() + '. Sync done.');
    return res;
  } catch (e) {
    logInfo_('SYNC ERROR: ' + (e && e.stack ? e.stack : e));
    throw e; // surfaces in execution log + failure email
  } finally {
    lock.releaseLock();
  }
}

// ---- checkpoint ---------------------------------------------------------

function getCheckpoint_() {
  return prop_(PROP.CHECKPOINT, false) || CONFIG.zoho.backfillStartDate;
}
function setCheckpoint_(isoDate) {
  if (isoDate) setProp_(PROP.CHECKPOINT, isoDate);
}
function isoDateOnly_(s) { return s ? String(s).slice(0, 10) : ''; }
function maxIso_(a, b) {
  if (!b) return a;
  if (!a) return b;
  return (String(b) > String(a)) ? b : a;
}

// ---- setup / verification helpers (run from the editor) -----------------

/** Confirm Zoho creds + org id resolve. Logs org name. */
function verifyZohoConnection() {
  var orgs = zohoListOrganizations_();
  logInfo_('OAuth OK. Organizations visible:');
  (orgs.organizations || []).forEach(function (o) {
    logInfo_('  ' + o.organization_id + '  ' + o.name + (o.is_default_org ? ' (default)' : ''));
  });
  logInfo_('Configured ORG_ID = ' + prop_(PROP.ORG_ID, false));
}

/** One-time: reset the checkpoint to the configured backfill start (re-pulls that window). */
function resetCheckpoint() {
  setProp_(PROP.CHECKPOINT, CONFIG.zoho.backfillStartDate);
  logInfo_('Checkpoint reset to ' + CONFIG.zoho.backfillStartDate);
}

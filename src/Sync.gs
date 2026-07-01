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
    var excluded = {};
    (CONFIG.zoho.excludeStatuses || []).forEach(function (s) { excluded[String(s).trim().toLowerCase()] = true; });
    var removeIds = {};   // doc ids whose rows must be deleted (void/draft), regardless of manual edits

    // ---- invoices ----
    var invHeaders = zohoListModified_('invoices', since).filter(function (h) {
      return String(h.date) >= floor;         // client-side floor (also guards if server filter is ignored)
    });
    logInfo_('Invoices changed (in scope): ' + invHeaders.length);
    invHeaders.forEach(function (h) {
      maxModified = maxIso_(maxModified, h.last_modified_time);
      if (excluded[String(h.status).trim().toLowerCase()]) {   // status is in the LIST response → no detail GET needed
        removeIds[String(h.invoice_id)] = true;
        return;
      }
      var inv = zohoGetInvoice_(h.invoice_id);   // list omits line_items → detail GET required
      if (excluded[String(inv.status).trim().toLowerCase()]) { removeIds[String(inv.invoice_id)] = true; return; }
      allRows = allRows.concat(invoiceToRows_(inv, ctx));
    });

    // ---- credit notes (returns) ----
    if (CONFIG.zoho.fetchCreditNotes) {
      var cnHeaders = zohoListModified_('creditnotes', since).filter(function (h) {
        return String(h.date) >= floor;
      });
      logInfo_('Credit notes changed (in scope): ' + cnHeaders.length);
      cnHeaders.forEach(function (h) {
        maxModified = maxIso_(maxModified, h.last_modified_time);
        if (excluded[String(h.status).trim().toLowerCase()]) { removeIds[String(h.creditnote_id)] = true; return; }
        var cn = zohoGetCreditNote_(h.creditnote_id);
        if (excluded[String(cn.status).trim().toLowerCase()]) { removeIds[String(cn.creditnote_id)] = true; return; }
        allRows = allRows.concat(creditNoteToRows_(cn, ctx));
      });
    }

    // ---- remove void/draft (and any that transitioned) BEFORE upserting; overrides manual edits ----
    var removed = deleteRowsByDocIds_(removeIds);
    if (removed) logInfo_('Removed ' + removed + ' row(s) for ' + Object.keys(removeIds).length + ' void/draft document(s) — manual edits ignored by design.');

    var res = writeRowsToLive_(allRows);
    logInfo_('Live upsert: ' + res.inserted + ' new, ' + res.updated + ' updated (' + allRows.length + ' line rows across ' + Object.keys(res.tabs).length + ' FY tab(s)). Manual tags on existing sales rows were preserved.');

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

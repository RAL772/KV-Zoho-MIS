# K.V. Toys — Zoho Books → Google Sheet Sales Sync

Automates the **Sales Register** tabs of the MIS dashboard's Google Sheet from **Zoho Books**,
headless, on a schedule. New sales flow **straight to the live tabs each run**; an admin reviews and
tags (GT/MT etc.) on a **weekly, non-blocking** cadence, and **any value a human sets in the specified
fields is never overwritten** by a later sync.

- **Extract:** Zoho Books REST API v3, dedicated Self-Client OAuth (India DC), incremental.
- **Write + schedule:** Google Apps Script (writes natively, self-triggers) — no server, no keys.
- **Pipeline:** `Zoho → live FY tab (upsert, manual fields preserved) → dashboard`; weekly manual review.

> New to this? Start with **[SETUP.md](SETUP.md)** — it's a click-by-click first run.

---

## Why this design (options considered)

The problem is three independent, composable choices: **(A)** extract from Zoho, **(B)** write to
Sheets, **(C)** schedule the hourly/daily job. Full analysis lives in the planning notes; summary:

### (A) Extract from Zoho Books
| Option | Verdict |
|---|---|
| **REST API v3 + dedicated Self-Client (chosen)** | Structured JSON incl. line items, true incremental sync via `last_modified_time`, fully headless. ⚠️ list endpoints omit line items → one detail-GET per invoice; shared per-org quota (100/min, 1k–10k/day by plan). |
| Zoho Analytics Bulk Export | Bulk, avoids per-record fan-out; needs a paid Analytics tier. **Fallback** if the shared API quota gets tight. |
| Zoho Flow / Deluge | Low-code inside Zoho; still hits the same rate-limited API for line detail. |
| Native Scheduled Reports | ❌ Weekly minimum — can't do hourly/daily. |
| Playwright / browser scrape | ❌ Sidesteps the API quota but adds MFA/login fragility, ToS risk, and a heavy runtime. Last resort only. |

**Chosen: REST API + dedicated Self-Client** — a separate OAuth client (own `client_id`/refresh token)
so it can't disturb your other Zoho integrations; read-only scopes; incremental + **daily** cadence
keeps call volume well under the shared quota.

### (B) Write to Google Sheets
| Option | Verdict |
|---|---|
| **Apps Script `setValues()` (chosen)** | Writes as the sheet owner — no service-account key, no "share as Editor" footgun. Values-only writes never change tab names/gids the dashboard relies on. Best fit for protected ranges + the admin menu. |
| Sheets API v4 + service account (`gspread`/Node) | Needed only if the job runs off-Google; requires sharing the sheet with the SA as Editor and batching to stay under 60 writes/min/user. |

### (C) Schedule / host
| Option | Verdict |
|---|---|
| **Apps Script time-driven trigger (chosen)** | $0, serverless in Google, native Sheets auth. Caps: 6 min/run, 90 min/day (consumer) / 6 h/day (Workspace) — fine for a small daily pull. |
| Cloudflare Worker cron | Graduation path if runs approach 6 min or you want to-the-minute firing on the Cloudflare account you already use. Needs a Google service account + RS256 JWT. |
| GitHub Actions cron | Version-controlled, free; scheduled runs are best-effort (can be delayed/dropped) → needs a heartbeat. |

---

## How the pipeline works

```
        ┌──────────────────── daily/hourly trigger (runSync) ────────────────────┐
        ▼                                                                         │
  Zoho Books ──list invoices/credit-notes modified since checkpoint──► detail-GET │ (line items)
        │                                                                         │
        └──map→ rows (FY-routed, GT/MT seeded, CP/COGS estimated) ──UPSERT──► [ Sales Register_FYxx-yy ]
                                                                                  │        ▲
                        new rows appear immediately (Verified=No, tag blank)      │        │ manual fields
                                                                                  ▼        │ preserved
                                                                         MIS dashboard (live)

  Weekly, non-blocking:  admin fills blank Channel mode + sets Verified=Yes on the live tabs
                         → future syncs never overwrite those values.
```

- **No per-run gate.** Each sync upserts new/changed rows **directly** into the live FY tabs, so the
  dashboard stays current automatically. New rows arrive with `Verified = No` and a seeded (or blank)
  `Channel mode` for the weekly review to finish.
- **Specified fields are sacred.** On a row that already exists, the sync **never overwrites a
  non-empty value** in `CONFIG.preserveOnUpdate` (default: `Channel mode`, `Verified`, `Admin Notes`).
  It may fill a still-blank one from the auto-resolver, but a human's value always wins. Those columns
  are also **protected ranges** — only `CONFIG.admin.editors` (and the owner) can edit them in-sheet.
- **Weekly review is a cleanup, not a gate.** `reviewSummary()` (menu: *Weekly review summary*) lists
  how many rows per FY tab still need a GT/MT tag or aren't `Verified=Yes`.
- **Void / draft are never sales.** Documents whose status is in `CONFIG.zoho.excludeStatuses`
  (`void`, `draft`) are never added, and if a previously-synced invoice **later turns void/draft**, all
  its rows are **deleted** on the next run — this override is intentional and **ignores manual edits**
  (a void/draft doc must not linger even if it was tagged). Detected from the list response, so no
  detail GET is spent on them.
- **Idempotent.** Every row is keyed `invoice_id|line_item_id` (credit notes `creditnote_id|line_id`),
  so re-runs upsert instead of duplicating. Returns are written as **negative** rows for netting.
- **Forward-only by default.** Historical FY tabs stay hand-maintained; the sync owns invoices dated
  on/after `CONFIG.zoho.backfillStartDate`. New FY tabs are auto-created (headers cloned) at roll-over.

---

## Data mapping (Zoho → Sales Register)

| Column | Source | Notes |
|---|---|---|
| Date | `invoice.date` | routes the FY tab (Apr–Mar) |
| Invoice No | `invoice.invoice_number` | |
| Customer | `invoice.customer_name` | |
| Salesperson | `invoice.salesperson_name` | |
| State | `place_of_supply` (GST code→name) | configurable to shipping/billing |
| Product Code | `line_items[].sku` (→ `item_id`) | |
| Product | `line_items[].name` | |
| Qty / Rate / Revenue | `quantity` / `rate` / `item_total` | |
| CP / COGS / Profit / Margin% | `qty × CP` from **Product Master** | **estimated** — not Zoho's FIFO P&L COGS |
| **Channel mode (GT/MT)** | invoice custom field → customer map → admin | **no native Zoho field** — admin verifies |
| Verified / Admin Notes | admin | protected |

Open items to confirm against your real data (see `// CONFIRM` in `Config.gs`): exact live-tab
**headers**, the channel **custom-field api_name** (`listCustomFields()` discovers it), the CP source,
and the `backfillStartDate`.

---

## Files
- `src/Config.gs` — all behaviour config (secrets live in Script Properties, not here).
- `src/ZohoClient.gs` — OAuth refresh, paginated fetch, backoff, detail GET, `listCustomFields()`.
- `src/Mapping.gs` — invoice/credit-note → rows; GT/MT, state, CP resolvers.
- `src/SheetIO.gs` — header-matched, **manual-field-preserving** upsert directly into live FY tabs;
  auto-creates a new FY tab (cloned headers) at roll-over.
- `src/Sync.gs` — orchestrator (`runSync`), checkpoint, `verifyZohoConnection()`.
- `src/Review.gs` — `reviewSummary()`: weekly counts of untagged / unverified rows.
- `src/Protect.gs` — admin-only protected ranges on the specified fields (`setupProtections()`).
- `src/Menu.gs` — custom menu, trigger install, Excel export/import.
- `src/appsscript.json` — manifest (scopes).

## Deploy
Push with [`clasp`](https://github.com/google/clasp) (`cp .clasp.json.example .clasp.json`, fill the
script id, `clasp push`) or paste the files into the Apps Script editor. Then follow **[SETUP.md](SETUP.md)**.

> ⚠️ This code targets your live Zoho org + Google Sheet and can't be executed in a CI sandbox — run
> the setup verification steps against a **copy** of the sheet first.

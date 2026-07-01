# K.V. Toys — Zoho Books → Google Sheet Sales Sync

Automates the **Sales Register** tabs of the MIS dashboard's Google Sheet from **Zoho Books**,
headless, on a schedule — with a **human-in-the-loop verify/tag step** so an admin approves every
row (and owns the GT/MT tagging) before it reaches the live dashboard.

- **Extract:** Zoho Books REST API v3, dedicated Self-Client OAuth (India DC), incremental.
- **Write + schedule:** Google Apps Script (writes natively, self-triggers) — no server, no keys.
- **Pipeline:** `Zoho → Staging tab → admin verify/tag → Promote → live FY tab → dashboard`.

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
                    ┌─────────────────────────── daily trigger (runSync) ───────────────────────────┐
                    ▼                                                                                │
  Zoho Books ──list invoices/credit-notes modified since checkpoint──► detail-GET each (line items) │
        │                                                                                           │
        └──map→ canonical rows (FY-routed, GT/MT seeded, CP/COGS estimated) ──upsert──► [ Staging ] ─┘
                                                                                             │
                                    admin reviews, sets Channel mode (GT/MT) + Verified=Yes  │  (protected columns)
                                                                                             ▼
                                   Promote ──tag-preserving upsert by invoice_id|line_item_id──► [ Sales Register_FYxx-yy ]
                                                                                             ▼
                                                                                    MIS dashboard (live)
```

- **Nothing reaches the dashboard until an admin promotes it.** The dashboard only reads the live
  `Sales Register_FY*` tabs; staged rows are invisible to it.
- **Admin owns the tags.** `Channel mode`, `Verified`, `Admin Notes` are **protected ranges** —
  editable only by the accounts in `CONFIG.admin.editors` (and the owner). The automation writes them
  through as owner but re-syncs never clobber an admin's edits.
- **Idempotent.** Every row is keyed `invoice_id|line_item_id` (credit notes `creditnote_id|line_id`),
  so re-runs upsert instead of duplicating. Returns are written as **negative** rows for netting.
- **Forward-only by default.** Historical FY tabs stay hand-maintained; the sync owns invoices dated
  on/after `CONFIG.zoho.backfillStartDate`.

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
- `src/SheetIO.gs` — header-matched, tag-preserving upsert; staging + promote.
- `src/Sync.gs` — orchestrator (`runSync`), checkpoint, `verifyZohoConnection()`.
- `src/Promote.gs` — thin promote entry (delegates to SheetIO).
- `src/Protect.gs` — admin-only protected ranges (`setupProtections()`).
- `src/Menu.gs` — custom menu, trigger install, Excel export/import.
- `src/appsscript.json` — manifest (scopes).

## Deploy
Push with [`clasp`](https://github.com/google/clasp) (`cp .clasp.json.example .clasp.json`, fill the
script id, `clasp push`) or paste the files into the Apps Script editor. Then follow **[SETUP.md](SETUP.md)**.

> ⚠️ This code targets your live Zoho org + Google Sheet and can't be executed in a CI sandbox — run
> the setup verification steps against a **copy** of the sheet first.

# Setup — Zoho Books → Google Sheet Sync (Apps Script)

One-time setup, ~30–45 min. Do it against a **copy** of the live Sheet first, then repoint.

---

## 0. Prerequisites
- Admin access to the Zoho Books org (to create a Self-Client) and its **data centre** (India = `.in`).
- The Google account that **owns** the target Sheet (Apps Script runs as this account).
- [`clasp`](https://github.com/google/clasp) installed *(optional — you can paste files instead)*.

---

## 1. Create a dedicated Zoho Self-Client (own credentials — won't touch your other integrations)
1. Go to the Zoho API console for your DC: **https://api-console.zoho.in** (India) → **Add Client** →
   **Self Client** → Create. Note the **Client ID** and **Client Secret**.
2. **Generate Code** tab:
   - **Scope:** `ZohoBooks.invoices.READ,ZohoBooks.creditnotes.READ,ZohoBooks.settings.READ,ZohoBooks.contacts.READ`
   - **Time Duration:** 10 minutes · **Scope Description:** anything → **Create** → copy the **grant code**.
3. Exchange the grant code for a **refresh token** (once). From a terminal (replace values, use your DC):
   ```bash
   curl -s "https://accounts.zoho.in/oauth/v2/token" \
     -d grant_type=authorization_code \
     -d client_id=YOUR_CLIENT_ID \
     -d client_secret=YOUR_CLIENT_SECRET \
     -d code=THE_GRANT_CODE
   ```
   Save the `refresh_token` from the JSON (it **does not expire**). *(The grant code is single-use and
   expires in minutes — if it fails, generate a new one.)*
4. Get your **organization_id**: Zoho Books → **Settings → Organizations**, or call `GET /organizations`.

---

## 2. Create the Apps Script project (bound to the Sheet — recommended)
1. Open the target Google Sheet → **Extensions → Apps Script**.
2. Add the files from `src/` (paste each `.gs` + set the manifest `appsscript.json` under
   Project Settings → “Show appsscript.json”). Or with clasp:
   ```bash
   cp .clasp.json.example .clasp.json      # put your Script ID in it
   clasp push
   ```

---

## 3. Store secrets in Script Properties
Apps Script editor → **Project Settings → Script Properties → Add**:

| Property | Value |
|---|---|
| `ZOHO_CLIENT_ID` | from step 1 |
| `ZOHO_CLIENT_SECRET` | from step 1 |
| `ZOHO_REFRESH_TOKEN` | from step 1 |
| `ZOHO_ORG_ID` | from step 1 |
| `SPREADSHEET_ID` | *(only if the script is standalone, not bound)* |

---

## 4. Align `Config.gs` to your real data (the `// CONFIRM` lines)
- `zoho.dc` — `in` for India.
- `zoho.backfillStartDate` — first invoice date the sync should own (e.g. start of current FY).
- `sheet.livePrefix` + tab names — must match your **exact** tab names (`Sales Register_FY25-26`, …).
- `columns[].header` — must match your live Sales Register's **exact headers** (order doesn't matter;
  matched by name/alias). Admin columns `Channel mode` / `Verified` / `Admin Notes` will be created on
  staging and should exist on live tabs (add them if missing — a `_Key` column is required on live
  tabs so promotion can upsert without duplicates).
- `admin.editors` — Google accounts allowed to edit tag columns.
- `channel.customFieldApiName` — run **`listCustomFields()`** (see step 5) to discover the real
  api_name, then paste it here. No channel field? Use the `Customer Channel Map` tab fallback.
- `cp.source` / header aliases — where cost price comes from (Product Master tabs).

---

## 5. First run & verification (on a COPY of the Sheet)
Run these from the editor (**Run** ▸ pick the function); authorize scopes on first run.
1. `verifyZohoConnection` → Executions log should list your org(s). Confirms OAuth + org id.
2. `listCustomFields` → copy the channel field's `api_name` into `Config.gs`.
3. `runSync` → check the **Staging** tab fills with rows; `Verified` = `No`, `Channel mode` seeded.
4. In Staging, set a few `Channel mode` (GT/MT) and `Verified` = `Yes`.
5. `setupProtections` → confirm a non-admin account can no longer edit the tag columns.
6. `promoteVerified` → verified rows move into the correct `Sales Register_FYxx-yy` tab; re-run
   `runSync` and confirm your tags were **not** overwritten (idempotency check).
7. Load the dashboard (`index.html`) against the copy → tabs parse, gid discovery works, KPIs render,
   no tab was renamed/recreated.

---

## 6. Schedule it
From the **KV Sync → Schedule** menu (or run `installDailyTrigger`): installs a daily `runSync`
trigger (~02:00 IST; edit in `Menu.gs`). Switch to `installHourlyTrigger` only if you need it and each
run stays under the 6-minute cap.

> **Cadence note:** daily keeps you comfortably under the shared Zoho per-org quota (100/min,
> 1k–10k/day by plan). If invoice volume ever makes per-invoice detail GETs blow the daily cap, move
> the bulk feed to the Zoho Analytics Bulk Export API (see README fallback).

---

## Daily operation (admin)
1. Sync runs automatically (or **KV Sync → Sync now**).
2. Open **Staging**, review new rows, set `Channel mode` where blank, mark `Verified = Yes`.
   *(Optional offline: **Export Staging to Excel**, edit, then **Import tags from a tab**.)*
3. **KV Sync → Promote verified rows → Live**. Done — the dashboard updates.

## Rolling into a new FY
Create the next tab additively with the **exact** name (`Sales Register_FY27-28`), give it the same
headers incl. `_Key`, then run `setupProtections` again. Never rename/recreate existing tabs.

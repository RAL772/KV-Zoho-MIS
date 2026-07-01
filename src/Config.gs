/**
 * Config.gs — single source of truth for the Zoho Books → Google Sheet sync.
 *
 * Secrets (Zoho client id/secret/refresh token, org id) live in Script Properties,
 * NOT here. See SETUP.md. This file only holds non-secret behaviour config.
 *
 * IMPORTANT: values marked  // CONFIRM  must be aligned to the real Zoho org / Sheet
 * before the first live run. They are safe, documented defaults — not guesses to ship blind.
 */

var CONFIG = {

  // ---- Zoho Books --------------------------------------------------------
  zoho: {
    dc: 'in',                 // data centre: 'in' (India), 'com' (US), 'eu', 'com.au', ...  // CONFIRM
    // Only fetch invoices dated on/after this. The automation is FORWARD-ONLY by design:
    // historical FY tabs stay hand-maintained/frozen. Set to the start of the FY you want
    // the sync to own. Format: 'YYYY-MM-DD'.
    backfillStartDate: '2026-04-01',                                            // CONFIRM
    perPage: 200,             // Zoho max page size
    maxRetries: 5,            // on HTTP 429 / transient errors (no Retry-After header from Zoho)
    // Modules to pull. Invoices are the core sales feed. Credit notes = returns (negative rows).
    fetchCreditNotes: true
  },

  // ---- Google Sheet ------------------------------------------------------
  sheet: {
    // If the script is BOUND to the spreadsheet, leave blank and it uses the active sheet.
    // If STANDALONE, put the spreadsheet id here (or in Script Property SPREADSHEET_ID).
    spreadsheetId: '',                                                         // CONFIRM (bound = blank)
    livePrefix: 'Sales Register_',   // live tabs are `${livePrefix}FY25-26`, etc.  // CONFIRM
    // When a new fiscal year starts and its tab doesn't exist yet, auto-create it by cloning
    // the header row of the newest existing live tab (so the sync never fails at FY roll-over).
    autoCreateFyTab: true,
    // Product Master tabs used to look up cost price (CP). Header matched by name below.
    productMasterGT: 'Product Master_GT',                                       // CONFIRM
    productMasterMT: 'Product Master_MT',                                       // CONFIRM
    // Optional customer→channel map tab (fallback when an invoice has no channel custom field).
    // Columns (by header): "Customer ID" | "Channel". Create it if you use this fallback.
    customerChannelTab: 'Customer Channel Map'
  },

  // ---- Admin / protection ------------------------------------------------
  admin: {
    // Google accounts allowed to edit the admin-owned (tag) columns. Everyone else is
    // blocked by protected ranges. The sheet OWNER is always allowed.
    editors: ['info.ralassociates@gmail.com']                                  // CONFIRM
  },

  // ---- GT / MT channel resolution ---------------------------------------
  // Zoho has no native channel field. Resolution order: (1) invoice custom field by api_name,
  // (2) customer→channel map tab, (3) blank → admin tags it during verification.
  channel: {
    customFieldApiName: 'cf_channel_mode',   // run listCustomFields() to discover the real one  // CONFIRM
    // Normalisation: map whatever staff type into canonical GT / MT.
    aliases: { gt: 'GT', 'general trade': 'GT', mt: 'MT', 'modern trade': 'MT' },
    defaultWhenUnknown: ''                    // leave blank so unresolved rows are obvious
  },

  // ---- Cost price (CP) / margin -----------------------------------------
  // COGS is NOT on the Zoho invoice line (Zoho computes FIFO from Bills). We compute an
  // ESTIMATED COGS = qty × CP. Source of CP:
  //   'product_master' — read the Product Master_GT/MT tab (no extra API calls; quota-friendly)
  //   'none'           — leave CP/COGS/Margin blank (dashboard can still compute what it needs)
  cp: {
    source: 'product_master',                                                  // CONFIRM
    // Header names (any alias, case-insensitive) to find the CP column in Product Master tabs.
    costHeaderAliases: ['cost price', 'cp', 'purchase rate', 'cost'],
    codeHeaderAliases: ['product code', 'code', 'item code', 'sku']
  },

  // ---- State derivation --------------------------------------------------
  // Where the "State" column comes from. place_of_supply is the canonical GST state code and
  // is the most reliably populated; we expand the 2-letter code to a full name via GST_STATES.
  state: {
    source: 'place_of_supply',   // 'place_of_supply' | 'shipping' | 'billing'   // CONFIRM
    expandGstCode: true
  },

  // ---- Number / date formatting on write --------------------------------
  // The dashboard cleans values per-column, so raw is safest and simplest. valueInputOption is
  // RAW-equivalent: Apps Script setValues writes typed values; we pass numbers + Date objects.
  format: {
    dates: 'iso',   // 'iso' → Date object (renders per cell format) ; 'string' → 'd-MMM-yy'
    numbersRaw: true
  },

  // ---- Column schema -----------------------------------------------------
  // Canonical field → header. `owner:'sync'` columns are written by the automation.
  // `owner:'admin'` columns are NEVER overwritten on rows that already exist (tags/verify).
  // On LIVE tabs we match columns by header/alias (any order); on STAGING we create them in
  // this order. Align `header` to the EXACT headers already in your live Sales Register.       // CONFIRM
  columns: [
    { field: 'date',        header: 'Date',           aliases: ['invoice date', 'txn date'], owner: 'sync', type: 'date' },
    { field: 'invoiceNo',   header: 'Invoice No',     aliases: ['invoice number', 'bill no'], owner: 'sync', type: 'text' },
    { field: 'customer',    header: 'Customer',       aliases: ['customer name', 'party'],    owner: 'sync', type: 'text' },
    { field: 'salesperson', header: 'Salesperson',    aliases: ['sales person', 'sales rep'], owner: 'sync', type: 'text' },
    { field: 'state',       header: 'State',          aliases: ['state name'],                owner: 'sync', type: 'text' },
    { field: 'code',        header: 'Product Code',   aliases: ['code', 'sku', 'item code'],  owner: 'sync', type: 'text' },
    { field: 'product',     header: 'Product',        aliases: ['product name', 'item'],      owner: 'sync', type: 'text' },
    { field: 'qty',         header: 'Qty',            aliases: ['quantity'],                  owner: 'sync', type: 'number' },
    { field: 'rate',        header: 'Rate',           aliases: ['unit price', 'selling rate'],owner: 'sync', type: 'number' },
    { field: 'revenue',     header: 'Revenue',        aliases: ['amount', 'sales', 'value'],  owner: 'sync', type: 'number' },
    { field: 'cp',          header: 'CP',             aliases: ['cost price', 'cost'],        owner: 'sync', type: 'number' },
    { field: 'cogs',        header: 'COGS',           aliases: ['cogs est', 'cost of goods'], owner: 'sync', type: 'number' },
    { field: 'profit',      header: 'Profit',         aliases: ['margin value'],              owner: 'sync', type: 'number' },
    { field: 'marginPct',   header: 'Margin%',        aliases: ['margin %', 'margin pct'],    owner: 'sync', type: 'number' },
    // ---- admin-owned (protected) ----
    { field: 'channel',     header: 'Channel mode',   aliases: ['channel', 'gt/mt'],          owner: 'admin', type: 'text' },
    { field: 'verified',    header: 'Verified',       aliases: ['verify', 'approved'],        owner: 'admin', type: 'text' },
    { field: 'adminNotes',  header: 'Admin Notes',    aliases: ['notes', 'remarks'],          owner: 'admin', type: 'text' },
    // ---- meta / technical ----
    { field: 'key',         header: '_Key',           aliases: [],                            owner: 'sync', type: 'text' },
    { field: 'zohoStatus',  header: '_Zoho Status',   aliases: [],                            owner: 'sync', type: 'text' },
    { field: 'lastModified',header: '_Last Modified', aliases: [],                            owner: 'sync', type: 'text' },
    { field: 'source',      header: '_Source',        aliases: [],                            owner: 'sync', type: 'text' }
  ],

  // ---- Manual "specified fields" (the core of the weekly-review model) ---
  // The sync writes NEW rows straight into the live FY tabs each run (no per-run gate). On rows
  // that ALREADY EXIST it never overwrites a NON-EMPTY value in these fields — so any tag/edit an
  // admin makes here survives every future sync. (A still-blank field may be filled by the
  // auto-resolver; a human value is sacred.) Add any column you hand-maintain to this list.
  preserveOnUpdate: ['channel', 'verified', 'adminNotes'],                     // CONFIRM (add fields you edit by hand)

  // Value the sync seeds into the Verified column for brand-new rows (admin flips to Yes weekly).
  verifiedNo: 'No',
  verifiedYes: 'Yes'
};

/** GST state code → full name (for state.expandGstCode). */
var GST_STATES = {
  '01': 'Jammu and Kashmir', '02': 'Himachal Pradesh', '03': 'Punjab', '04': 'Chandigarh',
  '05': 'Uttarakhand', '06': 'Haryana', '07': 'Delhi', '08': 'Rajasthan', '09': 'Uttar Pradesh',
  '10': 'Bihar', '11': 'Sikkim', '12': 'Arunachal Pradesh', '13': 'Nagaland', '14': 'Manipur',
  '15': 'Mizoram', '16': 'Tripura', '17': 'Meghalaya', '18': 'Assam', '19': 'West Bengal',
  '20': 'Jharkhand', '21': 'Odisha', '22': 'Chhattisgarh', '23': 'Madhya Pradesh', '24': 'Gujarat',
  '26': 'Dadra and Nagar Haveli and Daman and Diu', '27': 'Maharashtra', '28': 'Andhra Pradesh (Old)',
  '29': 'Karnataka', '30': 'Goa', '31': 'Lakshadweep', '32': 'Kerala', '33': 'Tamil Nadu',
  '34': 'Puducherry', '35': 'Andaman and Nicobar Islands', '36': 'Telangana', '37': 'Andhra Pradesh',
  '38': 'Ladakh', '97': 'Other Territory',
  // Zoho also exposes place_of_supply as the 2-letter state abbreviation in some orgs:
  'JK':'Jammu and Kashmir','HP':'Himachal Pradesh','PB':'Punjab','CH':'Chandigarh','UT':'Uttarakhand',
  'UK':'Uttarakhand','HR':'Haryana','DL':'Delhi','RJ':'Rajasthan','UP':'Uttar Pradesh','BR':'Bihar',
  'SK':'Sikkim','AR':'Arunachal Pradesh','NL':'Nagaland','MN':'Manipur','MZ':'Mizoram','TR':'Tripura',
  'ML':'Meghalaya','AS':'Assam','WB':'West Bengal','JH':'Jharkhand','OD':'Odisha','OR':'Odisha',
  'CG':'Chhattisgarh','MP':'Madhya Pradesh','GJ':'Gujarat','DN':'Dadra and Nagar Haveli and Daman and Diu',
  'DD':'Dadra and Nagar Haveli and Daman and Diu','MH':'Maharashtra','KA':'Karnataka','GA':'Goa',
  'LD':'Lakshadweep','KL':'Kerala','TN':'Tamil Nadu','PY':'Puducherry','AN':'Andaman and Nicobar Islands',
  'TG':'Telangana','TS':'Telangana','AP':'Andhra Pradesh','LA':'Ladakh'
};

/** Script Property keys (values set in SETUP.md, never committed). */
var PROP = {
  CLIENT_ID: 'ZOHO_CLIENT_ID',
  CLIENT_SECRET: 'ZOHO_CLIENT_SECRET',
  REFRESH_TOKEN: 'ZOHO_REFRESH_TOKEN',
  ORG_ID: 'ZOHO_ORG_ID',
  SPREADSHEET_ID: 'SPREADSHEET_ID',
  CHECKPOINT: 'SYNC_CHECKPOINT'   // ISO date of the last successful high-water mark
};

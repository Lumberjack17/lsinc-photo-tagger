// catalog.js - Part-number → description lookup from an Excel/CSV export.
//
// Two ways to supply the catalog (use either or both):
//   1. A published-spreadsheet URL (Google Sheets → File → Share → Publish to web → CSV,
//      or any hosted .csv). The app fetches it and caches it, so editing the sheet and
//      refreshing pulls the new data - no re-upload needed.
//   2. A one-off file import (.xlsx / .xls / .csv) from the device.
//
// The parsed map is cached in localStorage so lookups work instantly and offline.
//
// Exports:
//   setCatalogUrl(url) / getCatalogUrl()
//   refreshFromUrl()          → fetch + parse + cache the URL. Resolves catalog meta.
//   importFile(file)          → parse + cache an uploaded spreadsheet. Resolves meta.
//   loadCached()              → load the cached map into memory (call once on startup).
//   lookupPart(code)          → { partNumber, description, vendor } | null
//   getMeta()                 → { count, updatedAt, source } | null
//   clearCatalog()

const LS_URL = 'catalog_url';
const LS_MAP = 'catalog_map';
const LS_META = 'catalog_meta';
const XLSX_CDN = 'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js';

let map = {}; // { normalizedCode: { partNumber, description, vendor } }

// ── Config ───────────────────────────────────────────────────────────────────
export function getCatalogUrl() { return localStorage.getItem(LS_URL) || ''; }
export function setCatalogUrl(url) {
  if (url) localStorage.setItem(LS_URL, url.trim());
  else localStorage.removeItem(LS_URL);
}

export function getMeta() {
  try { return JSON.parse(localStorage.getItem(LS_META)); } catch (e) { return null; }
}

export function clearCatalog() {
  map = {};
  localStorage.removeItem(LS_MAP);
  localStorage.removeItem(LS_META);
}

// ── Lookup ─────────────────────────────────────────────────────────────────
function normKey(s) { return String(s ?? '').trim().toLowerCase(); }

export function lookupPart(code) {
  const k = normKey(code);
  if (map[k]) return map[k];
  // tolerate leading zeros being dropped/added by some scanners
  const stripped = k.replace(/^0+/, '');
  for (const key in map) {
    if (key.replace(/^0+/, '') === stripped) return map[key];
  }
  return null;
}

export function loadCached() {
  try {
    map = JSON.parse(localStorage.getItem(LS_MAP)) || {};
  } catch (e) { map = {}; }
  return getMeta();
}

// ── Build the map from parsed rows ───────────────────────────────────────────
function detectColumns(headers) {
  const lower = headers.map(h => String(h || '').trim().toLowerCase());
  const find = (...patterns) => {
    for (let i = 0; i < lower.length; i++) {
      if (patterns.some(p => p.test(lower[i]))) return i;
    }
    return -1;
  };
  const partIdx = find(/^part\s*(no\.?|number|#)?$/, /\bpart\s*(no|number|#)/, /^sku$/, /^item\s*(no|number|#)?$/, /^id$/, /^number$/);
  const descIdx = find(/desc/, /description/, /^name$/, /^title$/);
  const vendorIdx = find(/vendor/, /mfg/, /manufacturer/, /\bmpn\b/, /supplier/, /vendor\s*part/);
  return {
    partIdx: partIdx === -1 ? 0 : partIdx,
    descIdx: descIdx === -1 ? 1 : descIdx,
    vendorIdx,
  };
}

function buildMap(rows, source) {
  if (!rows.length) throw new Error('The file has no rows.');
  const headers = rows[0];
  const { partIdx, descIdx, vendorIdx } = detectColumns(headers);

  const next = {};
  let count = 0;
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    if (!row || !row.length) continue;
    const partNumber = String(row[partIdx] ?? '').trim();
    if (!partNumber) continue;
    next[normKey(partNumber)] = {
      partNumber,
      description: String(row[descIdx] ?? '').trim(),
      vendor: vendorIdx !== -1 ? String(row[vendorIdx] ?? '').trim() : '',
    };
    count++;
  }
  if (!count) throw new Error('No part numbers found. Check the column headers.');

  map = next;
  const meta = {
    count,
    updatedAt: new Date().toISOString(),
    source,
    columns: { part: headers[partIdx], description: headers[descIdx], vendor: vendorIdx !== -1 ? headers[vendorIdx] : null },
  };
  localStorage.setItem(LS_MAP, JSON.stringify(next));
  localStorage.setItem(LS_META, JSON.stringify(meta));
  return meta;
}

// ── CSV parsing (handles quoted fields, commas, and newlines) ────────────────
function parseCSV(text) {
  const rows = [];
  let row = [], field = '', inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field); field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter(r => r.some(cell => cell.trim() !== ''));
}

// ── XLSX parsing (lazy-loads SheetJS only when needed) ───────────────────────
function loadXLSX() {
  if (window.XLSX) return Promise.resolve(window.XLSX);
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = XLSX_CDN;
    s.onload = () => resolve(window.XLSX);
    s.onerror = () => reject(new Error('Failed to load the spreadsheet library'));
    document.head.appendChild(s);
  });
}

async function parseArrayBuffer(buf, filename) {
  if (/\.csv$/i.test(filename)) {
    return parseCSV(new TextDecoder().decode(buf));
  }
  const XLSX = await loadXLSX();
  const wb = XLSX.read(buf, { type: 'array' });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  return XLSX.utils.sheet_to_json(sheet, { header: 1, blankrows: false, defval: '' });
}

// ── Public loaders ───────────────────────────────────────────────────────────
export async function refreshFromUrl() {
  const url = getCatalogUrl();
  if (!url) throw new Error('No catalog URL set.');
  // Cache-buster so neither the browser nor the service worker serves a stale copy.
  const bust = (url.includes('?') ? '&' : '?') + '_ts=' + Date.now();
  const res = await fetch(url + bust, { cache: 'no-store' });
  if (!res.ok) throw new Error('Could not fetch the catalog (HTTP ' + res.status + ').');
  const buf = await res.arrayBuffer();
  // Published Google Sheets and hosted files are usually CSV; treat .xlsx URLs as binary.
  const name = /\.xlsx?(\?|$)/i.test(url) ? 'catalog.xlsx' : 'catalog.csv';
  const rows = await parseArrayBuffer(buf, name);
  return buildMap(rows, 'url');
}

export async function importFile(file) {
  const buf = await file.arrayBuffer();
  const rows = await parseArrayBuffer(buf, file.name);
  return buildMap(rows, 'file:' + file.name);
}

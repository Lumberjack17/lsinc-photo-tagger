// vision.js — Read a label with Claude Vision, with per-scan + running cost tracking.
//
// ⚠️ SECURITY: this calls the Anthropic API directly from the browser, so the API key
// is stored in this device's localStorage and is visible to anyone with access to the
// device or the network. That's fine for YOUR testing. For production / a shared team
// app, move this call behind a tiny server (e.g. a Supabase Edge Function) that holds
// the key, and have the app call that instead. Never commit a key to the repo.
//
// Exports:
//   getVisionConfig() / setVisionConfig({ apiKey, model, enabled })
//   extractLabel(dataUrl, knownCode) → { partNumber, description, usage, cost }
//   getCostSummary() / resetCost()
//   PRICING, MODELS

const API_URL = 'https://api.anthropic.com/v1/messages';

const LS_KEY = 'vision_api_key';
const LS_MODEL = 'vision_model';
const LS_ENABLED = 'vision_enabled';
const LS_COST = 'vision_cost';

// Published $/million-token rates (input includes image tokens).
export const PRICING = {
  'claude-opus-4-8':   { in: 5.00, out: 25.00, label: 'Opus 4.8 (most capable)' },
  'claude-sonnet-4-6': { in: 3.00, out: 15.00, label: 'Sonnet 4.6 (balanced)' },
  'claude-haiku-4-5':  { in: 1.00, out: 5.00,  label: 'Haiku 4.5 (cheapest, fast)' },
};
export const MODELS = Object.keys(PRICING);

// ── Config ───────────────────────────────────────────────────────────────────
export function getVisionConfig() {
  return {
    apiKey: localStorage.getItem(LS_KEY) || '',
    model: localStorage.getItem(LS_MODEL) || 'claude-opus-4-8',
    enabled: localStorage.getItem(LS_ENABLED) === '1',
  };
}
export function setVisionConfig({ apiKey, model, enabled }) {
  if (apiKey !== undefined) {
    if (apiKey) localStorage.setItem(LS_KEY, apiKey.trim());
    else localStorage.removeItem(LS_KEY);
  }
  if (model !== undefined) localStorage.setItem(LS_MODEL, model);
  if (enabled !== undefined) localStorage.setItem(LS_ENABLED, enabled ? '1' : '0');
}

// ── Cost tracking ──────────────────────────────────────────────────────────
export function getCostSummary() {
  try {
    return JSON.parse(localStorage.getItem(LS_COST)) || blankCost();
  } catch (e) { return blankCost(); }
}
function blankCost() { return { totalUSD: 0, scans: 0, inputTokens: 0, outputTokens: 0 }; }
export function resetCost() { localStorage.removeItem(LS_COST); }

function recordCost(usage, model) {
  const price = PRICING[model] || PRICING['claude-opus-4-8'];
  const cost = (usage.input_tokens / 1e6) * price.in + (usage.output_tokens / 1e6) * price.out;
  const s = getCostSummary();
  s.totalUSD += cost;
  s.scans += 1;
  s.inputTokens += usage.input_tokens;
  s.outputTokens += usage.output_tokens;
  localStorage.setItem(LS_COST, JSON.stringify(s));
  return cost;
}

// ── Extraction ─────────────────────────────────────────────────────────────
const SCHEMA = {
  type: 'object',
  properties: {
    part_number: { type: 'string', description: 'The part/SKU number on the label' },
    description: { type: 'string', description: 'The human-readable item description, e.g. "FUSE, 1.25A"' },
  },
  required: ['part_number', 'description'],
  additionalProperties: false,
};

export async function extractLabel(dataUrl, knownCode) {
  const { apiKey, model } = getVisionConfig();
  if (!apiKey) throw new Error('No Claude API key set.');

  const base64 = dataUrl.replace(/^data:image\/\w+;base64,/, '');

  const prompt =
    'This is a photo of a warehouse inventory bin label. It has a part/SKU number ' +
    '(a large number, usually top-left and/or printed under the barcode) and a human-readable ' +
    'item description (e.g. "FUSE, 1.25A" or "M8 T-nut with leaf").' +
    (knownCode ? ` The barcode scanned as "${knownCode}" — use that as the part_number.` : '') +
    ' Extract the part_number and the description. If you cannot read the description, return an empty string for it.';

  const body = {
    model,
    max_tokens: 400,
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: base64 } },
        { type: 'text', text: prompt },
      ],
    }],
    output_config: { format: { type: 'json_schema', schema: SCHEMA } },
  };

  const res = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    let msg = 'HTTP ' + res.status;
    try { const e = await res.json(); msg = e.error?.message || msg; } catch (_) {}
    throw new Error('Claude API error: ' + msg);
  }

  const data = await res.json();
  const textBlock = (data.content || []).find(b => b.type === 'text');
  let parsed = {};
  try { parsed = JSON.parse(textBlock?.text || '{}'); } catch (_) {}

  const cost = recordCost(data.usage || { input_tokens: 0, output_tokens: 0 }, model);

  return {
    partNumber: parsed.part_number || knownCode || '',
    description: parsed.description || '',
    usage: data.usage,
    cost,
    model: data.model || model,
  };
}

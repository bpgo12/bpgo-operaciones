"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.join(__dirname, "..");
const worker = fs.readFileSync(path.join(root, "_worker.js"), "utf8");

function functionSource(name) {
  const start = worker.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `missing ${name}`);
  const brace = worker.indexOf("{", start);
  let depth = 0;
  for (let index = brace; index < worker.length; index += 1) {
    if (worker[index] === "{") depth += 1;
    if (worker[index] === "}") depth -= 1;
    if (depth === 0) return worker.slice(start, index + 1);
  }
  throw new Error(`unterminated ${name}`);
}

// El reporte requiere sesión y lee el origen del anuncio desde la bandeja ya guardada.
assert.match(worker, /url\.pathname === "\/api\/whatsapp\/ad-referrals" && request\.method === "GET"\) \{\s*\n\s*const session = await readSession/);
assert.match(worker, /raw_json LIKE '%"referral"%'/);
assert.ok(fs.existsSync(path.join(root, "anuncios.html")));

const context = { JSON, Map, String };
vm.createContext(context);
vm.runInContext(`${functionSource("adReferralFromMessage")}\n${functionSource("summarizeAdReferrals")}\nthis.adReferralFromMessage = adReferralFromMessage; this.summarizeAdReferrals = summarizeAdReferrals;`, context);

assert.equal(context.adReferralFromMessage({ type: "text", text: { body: "hola" } }), null);
assert.equal(context.adReferralFromMessage(null), null);
const parsed = context.adReferralFromMessage({ referral: { source_type: "ad", source_id: "120200", headline: "  Fibra hasta 500 Mb/s  ", ctwa_clid: "abc" } });
assert.equal(parsed.sourceId, "120200");
assert.equal(parsed.headline, "Fibra hasta 500 Mb/s");
assert.equal(parsed.ctwaClid, "abc");

const msg = (phone, at, referral) => ({ phone, customer_name: `Cliente ${phone}`, created_at: at, raw_json: JSON.stringify({ from: phone, referral }) });
const adA = { source_type: "ad", source_id: "A1", headline: "Fibra en Cayucupil" };
const adB = { source_type: "ad", source_id: "B2", headline: "Internet en el lago" };
const rows = [
  msg("56911111111", "2026-11-01T10:00:00.000Z", adA),
  msg("56911111111", "2026-11-01T10:05:00.000Z", adA), // mismo teléfono: una sola conversación
  msg("56922222222", "2026-11-02T10:00:00.000Z", adA),
  msg("56933333333", "2026-11-03T10:00:00.000Z", adB),
  { phone: "56944444444", customer_name: null, created_at: "2026-11-03T11:00:00.000Z", raw_json: "no es json" },
];
const leads = new Map([["56911111111", "completed"], ["56922222222", "awaiting_location"]]);
const summary = context.summarizeAdReferrals(rows, leads);
assert.equal(summary.length, 2);
assert.equal(summary[0].adId, "A1");
assert.equal(summary[0].conversations, 2);
assert.equal(summary[0].salesLeads, 2);
assert.equal(summary[0].completed, 1);
assert.equal(summary[0].firstAt, "2026-11-01T10:00:00.000Z");
assert.equal(summary[0].lastAt, "2026-11-02T10:00:00.000Z");
assert.equal(summary[1].adId, "B2");
assert.equal(summary[1].conversations, 1);
assert.equal(summary[1].salesLeads, 0);

console.log("ad-referrals tests passed");

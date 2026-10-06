"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const worker = fs.readFileSync(path.join(__dirname, "..", "_worker.js"), "utf8");
const page = fs.readFileSync(path.join(__dirname, "..", "pagar.html"), "utf8");

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

function constSource(name) {
  const start = worker.indexOf(`const ${name} =`);
  assert.notEqual(start, -1, `missing const ${name}`);
  const lineEnd = worker.indexOf("\n", start);
  return worker.slice(start, lineEnd === -1 ? undefined : lineEnd).trim();
}

const calls = [];
const context = { Set, Number, String, Array, Date, JSON, Math, URL, Promise, crypto: globalThis.crypto, Object };
context.fetch = async (url, options) => {
  calls.push({ url, options });
  return { ok: true, status: 200, json: async () => ({ token: "TOKEN123", url: "https://webpay3gint.transbank.cl/webpayserver/initTransaction" }) };
};
context.AbortSignal = AbortSignal;
vm.createContext(context);
vm.runInContext(`
  const SPANISH_MONTH_NAMES = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];
  ${constSource("WEBPAY_PRODUCTION_BASE")}
  ${constSource("WEBPAY_MAX_AMOUNT")}
  const WEBPAY_INTEGRATION = Object.freeze({ base: "https://webpay3gint.transbank.cl", commerceCode: "597055555532", apiKey: "k" });
  ${functionSource("normalizeWhatsAppPhone")}
  ${functionSource("webpayConfig")}
  ${functionSource("webpayMaskName")}
  ${functionSource("webpayDebtsForPhone")}
  async ${functionSource("webpayRequest")}
  async ${functionSource("webpayLookup")}
  async ${functionSource("webpayCreate")}
  this.api = { webpayConfig, webpayMaskName, webpayDebtsForPhone, webpayLookup, webpayCreate };
`, context);
const api = context.api;

// --- Ambiente: pruebas por defecto; producción solo con variable + ambas credenciales ---
assert.equal(api.webpayConfig({}).production, false);
assert.equal(api.webpayConfig({ TRANSBANK_ENV: "production" }).production, false, "sin credenciales nunca es producción");
assert.equal(api.webpayConfig({ TRANSBANK_ENV: "production", TRANSBANK_COMMERCE_CODE: "123" }).production, false);
const production = api.webpayConfig({ TRANSBANK_ENV: "production", TRANSBANK_COMMERCE_CODE: "123", TRANSBANK_API_KEY: "abc" });
assert.equal(production.production, true);
assert.equal(production.base, "https://webpay3g.transbank.cl");
assert.equal(api.webpayConfig({ TRANSBANK_COMMERCE_CODE: "123", TRANSBANK_API_KEY: "abc" }).production, false, "las credenciales solas no activan producción");

// --- Nombre enmascarado (el portal es público: no se muestra el nombre completo) ---
assert.equal(api.webpayMaskName("MIRTA PINO OSORIO"), "Mirta O.");
assert.equal(api.webpayMaskName("juan"), "Juan");
assert.equal(api.webpayMaskName(""), "Cliente BPGO");

// --- Deudas pagables ---
const state = {
  billingRecords: [
    { id: "r-oct", phone: "56911112222", status: "Pendiente", amount: 18000, billingMonth: "octubre", customerName: "Ana Gómez Pérez" },
    { id: "r-sep", phone: "911112222", status: "Suspendido", amount: 18000, billingMonth: "septiembre", customerName: "Ana Gómez Pérez" },
    { id: "r-ago", phone: "56911112222", status: "Pagado", amount: 18000, billingMonth: "agosto", customerName: "Ana Gómez Pérez" },
    { id: "r-cero", phone: "56911112222", status: "Pendiente", amount: 0, billingMonth: "julio", customerName: "Ana Gómez Pérez" },
    { id: "r-otro", phone: "56933334444", status: "Pendiente", amount: 25000, billingMonth: "octubre", customerName: "Luis Soto" },
  ],
};
const debts = api.webpayDebtsForPhone(state, "56911112222");
assert.deepEqual(debts.map((record) => record.id), ["r-sep", "r-oct"], "solo Pendiente/Suspendido con monto, en orden de mes");

const fakeEnv = (inserts = []) => ({
  DB: {
    prepare(sql) {
      return {
        bind: (...args) => ({
          first: async () => ({ data: JSON.stringify(state) }),
          run: async () => { inserts.push({ sql, args }); return { meta: { changes: 1 } }; },
        }),
        first: async () => ({ data: JSON.stringify(state) }),
      };
    },
  },
});

(async () => {
  const invalid = await api.webpayLookup(fakeEnv(), "123");
  assert.equal(invalid.ok, false);
  const none = await api.webpayLookup(fakeEnv(), "9 9999 9999");
  assert.equal(none.found, false);
  const found = await api.webpayLookup(fakeEnv(), "9 1111 2222");
  assert.equal(found.found, true);
  assert.equal(found.customer, "Ana P.");
  assert.deepEqual(found.records.map((record) => record.amount), [18000, 18000]);
  assert.equal(JSON.stringify(found).includes("Gómez"), false, "el apellido completo no se expone");

  // --- Creación: el monto sale del servidor, nunca del navegador ---
  const inserts = [];
  const request = new Request("https://operaciones.bpgo.cl/api/pay/create", { method: "POST" });
  const created = await api.webpayCreate(fakeEnv(inserts), request, { phone: "911112222", recordIds: ["r-oct", "r-sep"], amount: 1 });
  assert.equal(created.ok, true);
  assert.equal(created.amount, 36000, "ignora cualquier monto enviado por el cliente");
  assert.equal(created.test, true, "sin variables de producción es ambiente de pruebas");
  const sent = JSON.parse(calls[calls.length - 1].options.body);
  assert.equal(sent.amount, 36000);
  assert.equal(sent.return_url, "https://operaciones.bpgo.cl/api/pay/return");
  assert.ok(sent.buy_order.length <= 26, "buy_order máx 26 caracteres");
  assert.equal(calls[calls.length - 1].url, "https://webpay3gint.transbank.cl/rswebpaytransaction/api/webpay/v1.2/transactions");
  assert.equal(calls[calls.length - 1].options.headers["Tbk-Api-Key-Id"], "597055555532");

  const foreign = await api.webpayCreate(fakeEnv(), request, { phone: "911112222", recordIds: ["r-otro"] });
  assert.equal(foreign.ok, false, "no se puede pagar un registro de otro teléfono");
  const paid = await api.webpayCreate(fakeEnv(), request, { phone: "911112222", recordIds: ["r-ago"] });
  assert.equal(paid.ok, false, "un mes ya pagado no se cobra de nuevo");
  const empty = await api.webpayCreate(fakeEnv(), request, { phone: "911112222", recordIds: [] });
  assert.equal(empty.ok, false);

  console.log("webpay plus: ok");
})().catch((error) => { console.error(error); process.exit(1); });

// --- Aserciones sobre el flujo completo del Worker ---
assert.match(worker, /if \(url\.pathname\.startsWith\("\/api\/pay\/"\)\) return handleWebpayApi\(request, env, ctx, url\);/);
assert.ok(worker.indexOf('startsWith("/api/pay/")') < worker.indexOf('"/api/whatsapp/cyber-upgrade") {'), "las rutas públicas de pago se atienden antes que el resto");
assert.match(worker, /UPDATE webpay_transactions SET status = 'committing', committed_at = datetime\('now'\) WHERE token = \? AND committed_at IS NULL/);
assert.match(worker, /data\.status === "AUTHORIZED" && Number\(data\.response_code\) === 0 && Number\(data\.amount\) === Number\(row\.amount\)/);
assert.match(worker, /if \(finalStatus === "authorized" && row\.mode === "production"\) \{\s*\n\s*const result = await applyWebpayPayment/);
assert.match(worker, /Modo de pruebas: no se aplicó a la planilla\./);
assert.match(worker, /if \(record\.status !== "Pendiente"\) \{ skipped\.push/);
assert.match(worker, /WHERE id = 'main' AND updated_at IS \?/);
assert.match(worker, /sourceMessageId: `webpay-\$\{row\.buy_order\}`/);
assert.match(worker, /webpayRateLimited\(env, request, "lookup", WEBPAY_LOOKUPS_PER_HOUR\)/);
assert.match(worker, /webpayRateLimited\(env, request, "create", WEBPAY_CREATES_PER_HOUR\)/);
assert.match(worker, /TBK_TOKEN/);
assert.match(worker, /session\.role !== "super_admin"/);
// El Worker nunca debe contener credenciales de producción: solo las públicas de pruebas de Transbank.
assert.doesNotMatch(worker, /TRANSBANK_API_KEY\s*=\s*["'][A-Za-z0-9]{20,}/);
// Página pública
assert.match(page, /\/api\/pay\/lookup/);
assert.match(page, /\/api\/pay\/create/);
assert.match(page, /token_ws/);
assert.match(page, /noindex/);
assert.doesNotMatch(page, /innerHTML\s*=\s*[^"]*\+\s*record/, "los datos del cliente se insertan con textContent, no con innerHTML");

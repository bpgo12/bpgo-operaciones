"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const worker = fs.readFileSync(path.join(__dirname, "..", "_worker.js"), "utf8");

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

const context = { Date, Intl, String, Number, Set, Map, Array, Object };
vm.createContext(context);
vm.runInContext(`
  const BILLING_MONTHS_ES = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];
  function normalizeWhatsAppPhone(value) { let phone=String(value||"").replace(/\\D/g,""); if(phone.startsWith("0")) phone=phone.slice(1); if(phone.length===9) phone="56"+phone; return phone; }
  ${functionSource("chileDateParts")}
  ${functionSource("billingStageForDate")}
  ${functionSource("billingMonthKey")}
  ${functionSource("normalizeSheetHeader")}
  ${functionSource("parseBillingAmount")}
  ${functionSource("billingSheetColumns")}
  ${functionSource("billingEligibilityFromRows")}
  this.api={billingStageForDate,billingMonthKey,billingEligibilityFromRows};
`, context);

const api = context.api;
assert.equal(api.billingStageForDate(new Date("2026-09-20T16:00:00Z")), "day20");
assert.equal(api.billingStageForDate(new Date("2026-09-21T16:00:00Z")), null);
assert.equal(api.billingStageForDate(new Date("2026-09-22T16:00:00Z")), "day22");
assert.equal(api.billingStageForDate(new Date("2026-09-23T16:00:00Z")), "day23");
assert.equal(api.billingMonthKey(new Date("2026-09-23T16:00:00Z")), "2026-09");

const headers = ["ID del Cliente", "Nombre del Cliente", "Dirección", "SECTOR", "Teléfono", "Plan Contratado", "MONTO TOTAL", "Septiembre", "fecha pago septiembre", "Septiembre", "ESTADO BPGO"];
const rows = [headers,
  ["1", "Pendiente", "A", "Norte", "912345671", "Plan", "$21.300", "PAGADO", "", "", "ACTIVO"],
  ["2", "Pagado", "A", "Norte", "912345672", "Plan", "$21.300", "", "", "PAGADO", "ACTIVO"],
  ["3", "Cortado", "A", "Norte", "912345673", "Plan", "$21.300", "", "", "", "CORTADO"],
  ["4", "Inactivo", "A", "Norte", "912345674", "Plan", "$21.300", "", "", "", "inactive"],
  ["5", "Cero", "A", "Norte", "912345675", "Plan", "$0", "", "", "", "ACTIVO"],
  ["6", "Inválido", "A", "Norte", "123", "Plan", "$21.300", "", "", "", "ACTIVO"],
  ["7", "Comprobante", "A", "Norte", "912345677", "Plan", "$21.300", "", "", "", "ACTIVO"],
  ["8", "Duplicado A", "A", "Norte", "912345678", "Plan", "$21.300", "", "", "", "ACTIVO"],
  ["9", "Duplicado B", "A", "Norte", "912345678", "Plan", "$21.300", "", "", "", "ACTIVO"],
];
const parsed = api.billingEligibilityFromRows(rows, new Date("2026-09-23T16:00:00Z"), new Set(["56912345677"]));
assert.equal(parsed.ok, true);
// Orden de Carlos (2026-10-20): un comprobante en revisión NO excluye; solo manda la planilla (el cliente "Comprobante" sí recibe el recordatorio).
assert.deepEqual(Array.from(parsed.eligible, (item) => item.customerName), ["Pendiente", "Comprobante"]);
const reasons = Array.from(parsed.excluded, (item) => item.reason);
for (const reason of ["paid", "inactive_or_suspended", "non_positive_amount", "invalid_phone", "duplicate_phone"]) {
  assert.ok(reasons.includes(reason), `missing exclusion ${reason}`);
}

assert.doesNotMatch(worker, /reason = "pending_receipt"/);
assert.equal((worker.match(/async function runBillingAutomation\(/g) || []).length, 1);
assert.equal((worker.match(/function billingAutomationTemplateDefinition\(/g) || []).length, 1);
assert.match(worker, /\["accepted", "sent", "delivered", "read"\]\.includes\(previous\.status\)/);
assert.match(worker, /Google Sheets falló durante la revalidación; lote detenido/);
assert.match(worker, /template\?\.status !== "APPROVED"/);
assert.match(worker, /billing_suspension_queue/);
assert.match(worker, /claims\.repository === "bpgo12\/bpgo-operaciones"/);
assert.match(worker, /claims\.ref === "refs\/heads\/main"/);
assert.match(worker, /claims\.event_name/);
// Orden de Carlos (2026-10-20): los comprobantes (aprobados o no) ya no excluyen a nadie de la cobranza; solo manda la planilla.
assert.doesNotMatch(worker, /status='approved' AND strftime\('%Y-%m', created_at\) = \?/);
assert.match(worker, /async function pendingPaymentReceiptPhones\(\) \{\s*\n\s*return new Set\(\);/);

console.log("billing automation: ok");

// 2026-10-15: el envío manual ("Enviar lote por API") aplica las mismas reglas que la cobranza automática
// (no cortados/suspendidos, no pagados, con monto) contra la planilla leída al momento; sin planilla no envía.
{
  const src = require("node:fs").readFileSync(require("node:path").join(__dirname, "..", "_worker.js"), "utf8");
  const start = src.indexOf("async function sendBillingMessages(");
  const body = src.slice(start, src.indexOf("\nfunction toBase64Url(", start));
  require("node:assert/strict").match(body, /billingEligibilityFromRows\(source\.rows/);
  require("node:assert/strict").match(body, /fetchFreshBillingSource\(env\)/);
  require("node:assert/strict").match(body, /billingAllowed && !billingAllowed\.eligible\.has\(phone\)/);
  require("node:assert/strict").match(body, /no se envió ningún mensaje/);
}

// 2026-10-23: la cobranza automática está en pausa mientras se repara el número de WhatsApp; la corrida responde "omitida" antes de tocar Meta o la planilla.
assert.match(worker, /const BILLING_AUTOMATION_PAUSED = true;\s*async function runBillingAutomation\(env, options = \{\}\) \{\s*if \(BILLING_AUTOMATION_PAUSED\) return \{ ok: true, skipped: true, reason: "paused" \};/);

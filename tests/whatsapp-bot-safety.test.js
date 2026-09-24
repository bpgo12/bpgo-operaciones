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

const context = { Set, Map, Number, String, Array, Date };
vm.createContext(context);
vm.runInContext(`
  const BILLING_REVIEW_REPLY = "Voy a dejar esta consulta para revisión del equipo antes de confirmarte el monto.";
  function inferServiceMonth(){ return null; }
  function inferAmount(){ return null; }
  ${functionSource("formatCurrency")}
  ${functionSource("isBalanceQuestion")}
  ${functionSource("authoritativeBalanceAction")}
  ${functionSource("classifyInboundMessage")}
  ${functionSource("hasExplicitPaymentIntent")}
  ${functionSource("hasStrongReceiptEvidence")}
  ${functionSource("isPlausibleAccountName")}
  ${functionSource("isPaymentLinkRequest")}
  ${functionSource("isAlternativePaymentRequest")}
  ${functionSource("briefCourtesyReply")}
  ${functionSource("externalConnectivityPaymentReply")}
  ${functionSource("cancellationMeansPayment")}
  ${functionSource("extractWhatsAppMessageEchoes")}
  ${functionSource("isPaidQuickReply")}
  ${functionSource("humanizeFilename")}
  ${functionSource("inboundMessageText")}
  this.api = { formatCurrency, isBalanceQuestion, authoritativeBalanceAction, classifyInboundMessage, hasStrongReceiptEvidence, isPlausibleAccountName, isPaymentLinkRequest, isAlternativePaymentRequest, briefCourtesyReply, externalConnectivityPaymentReply, cancellationMeansPayment, extractWhatsAppMessageEchoes, isPaidQuickReply, humanizeFilename, inboundMessageText };
`, context);

const api = context.api;
assert.equal(api.formatCurrency(null), null);
assert.equal(api.formatCurrency(undefined), null);
assert.equal(api.formatCurrency(""), null);
assert.equal(api.formatCurrency("no-numérico"), null);
assert.equal(api.isBalanceQuestion("¿Cuánto debo este mes?"), true);
assert.equal(api.isBalanceQuestion("¿Debo reiniciar el router?"), false);
assert.equal(api.authoritativeBalanceAction({ id: null, balance: null }).action, "escalate");
assert.equal(api.authoritativeBalanceAction({ id: "1", billingAuthoritative: true, balance: null, paymentStatus: "Pendiente" }).action, "escalate");
assert.equal(api.authoritativeBalanceAction({ id: "1", billingAuthoritative: true, balance: 21300, paymentStatus: "Pendiente" }).text, "Tu saldo pendiente registrado es de $21.300.");
assert.equal(api.authoritativeBalanceAction({ id: "1", billingAuthoritative: true, balance: 0, paymentStatus: "Pendiente" }).action, "escalate");
assert.match(api.authoritativeBalanceAction({ id: "1", billingAuthoritative: true, balance: 0, paymentStatus: "Pagado" }).text, /sin deuda/);
assert.equal(api.authoritativeBalanceAction({ id: "1", billingAuthoritative: true, billingAmbiguous: true, balance: 12000, paymentStatus: "Pendiente" }).action, "escalate");

assert.equal(api.classifyInboundMessage({ mediaId: "1", type: "image", text: "" }).type, "general");
assert.equal(api.classifyInboundMessage({ mediaId: "1", type: "image", text: "foto del router con luz roja" }).type, "technical_fault");
assert.equal(api.classifyInboundMessage({ mediaId: "1", type: "image", text: "adjunto comprobante, ya pagué" }).type, "payment");
assert.equal(api.hasStrongReceiptEvidence({ receipt_evidence: ["bank", "amount", "date_time"] }, { mediaId: "1", mediaType: "image", customerText: "" }), true);
assert.equal(api.hasStrongReceiptEvidence({ receipt_evidence: ["amount", "date_time"] }, { mediaId: "1", mediaType: "image", customerText: "" }), false);
assert.equal(api.hasStrongReceiptEvidence({}, { mediaId: "1", mediaType: "document", customerText: "" }), false);
assert.equal(api.hasStrongReceiptEvidence({}, { mediaId: "1", mediaType: "document", customerText: "te envío el comprobante" }), true);

assert.equal(api.isPlausibleAccountName("Juan Pérez"), true);
assert.equal(api.isPlausibleAccountName("María González Soto"), true);
for (const value of ["gracias", "ya pagué", "ahí está pagado gracias", "listo", "sí", "correcto", "ese es"]) {
  assert.equal(api.isPlausibleAccountName(value), false, `${value} must not be stored as a name`);
}
for (const value of ["Me manda el link para pagar", "Dónde pago", "Pásame el enlace de pago", "Quiero pagar el plan"]) {
  assert.equal(api.isPaymentLinkRequest(value), true, `${value} must use the official payment portal`);
}
for (const value of ["La cuenta para depositar sigue siendo la misma cierto", "¿Cuál es la cuenta para depositar?", "Mándame la cuenta para transferir", "¿Puedo pagar por caja vecina?", "Hola tiene la misma cuenta", "Son los mismos datos"]) {
  assert.equal(api.isAlternativePaymentRequest(value), true, `${value} must use transfer fallback`);
}
assert.equal(api.briefCourtesyReply("Gracias"), "De nada 👍");
assert.equal(api.externalConnectivityPaymentReply("a la tarde cancelo esta mala la señal donde trabajo"), "Entendido, puedes realizar el pago más tarde cuando tengas mejor conexión.");
assert.equal(api.externalConnectivityPaymentReply("en la tarde pago, tengo poca cobertura en la minera"), "Entendido, puedes realizar el pago más tarde cuando tengas mejor conexión.");
assert.equal(api.externalConnectivityPaymentReply("tengo mala señal de internet BP GO en la casa"), null);
assert.equal(api.cancellationMeansPayment("Cancelar", [{ direction: "outbound", message_text: "Tu mensualidad continúa pendiente de pago. Puedes regularizarla en https://bpgo.cl/pagar" }]), true);
assert.equal(api.cancellationMeansPayment("Otro ratito voy a cancelar", [{ direction: "outbound", message_text: "Recordatorio de pago" }]), true);
assert.equal(api.cancellationMeansPayment("Quiero cancelar el servicio", [{ direction: "outbound", message_text: "Tu mensualidad está pendiente" }]), false);
assert.equal(api.cancellationMeansPayment("Quiero dar de baja el plan", [{ direction: "outbound", message_text: "Tu mensualidad está pendiente" }]), false);

const echoes = api.extractWhatsAppMessageEchoes([{ field: "smb_message_echoes", value: { messages: [{ id: "manual-1", to: "56911111111" }] } }]);
assert.equal(echoes.length, 1);
assert.equal(echoes[0].id, "manual-1");

assert.doesNotMatch(worker, /sin saldo pendiente registrado/);
assert.match(worker, /setBotSessionMode\(env, phone, "human", "manual_whatsapp_reply"\)/);
assert.match(worker, /if \(await isKnownApiOutboundMessage\(env, message\.id\)\) continue/);
assert.match(worker, /matchedCustomer\.matchedByPhone \? matchedCustomer\.name/);
assert.match(worker, /Interpreta respuestas cortas \(sí, no, ya, listo, correcto, ese, números, fechas o colores\) según la última pregunta/);
assert.match(worker, /pregunta UNA sola cosa por respuesta/);
assert.match(worker, /Antes de asumir que palabras como "señal"/);
assert.match(worker, /En conversaciones de cobranza, interpreta "cancelar"/);
assert.match(worker, /Necesito el nombre del titular del servicio, por ejemplo: Juan Pérez\./);
assert.match(worker, /if \(message\.id && !\(await claimInboundMessageForBot\(env, message\.id\)\)\) continue/);
assert.match(worker, /context\.customer\.dueDate && Date\.parse\(context\.customer\.dueDate\) >= Date\.now\(\)/);
assert.match(worker, /const monthName = SPANISH_MONTH_NAMES\[chileDateParts\(\)\.month - 1\]/);
assert.match(worker, /return SPANISH_MONTH_NAMES\[chileDateParts\(\)\.month - 1\]/);

for (const value of ["PAGO INGRESADO", "pago ingresado", "ya pagué", "hice el pago", "ingresé el pago", "pago realizado"]) {
  assert.equal(api.isPaidQuickReply(value), true, `${value} must be recognized as an explicit paid statement`);
}
for (const value of ["cuánto pago", "cómo pago", "necesito pagar", "voy a pagar mañana"]) {
  assert.equal(api.isPaidQuickReply(value), false, `${value} must NOT be treated as an already-paid statement`);
}

assert.equal(api.humanizeFilename("webpaycl-comprobantePago-GACIDNn660Noz2PEy7EWJ.pdf").toLowerCase().includes("comprobante pago"), true);
assert.equal(
  api.inboundMessageText({ document: { filename: "webpaycl-comprobantePago-GACIDNn660Noz2PEy7EWJ.pdf" } }).toLowerCase().includes("comprobante pago"),
  true,
);
const replyRoute = worker.slice(worker.indexOf('url.pathname === "/api/whatsapp/reply"'), worker.indexOf('url.pathname === "/api/whatsapp/message-status"'));
assert.ok(replyRoute.indexOf('setBotSessionMode(env, phone, "human", "manual_reply", session)') < replyRoute.indexOf("await fetch(endpoint"));

console.log("whatsapp bot safety: ok");

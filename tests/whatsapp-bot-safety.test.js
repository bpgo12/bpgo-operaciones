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
  ${functionSource("isLikelyNotAName")}
  ${functionSource("classifyInstallationFragment")}
  ${functionSource("mentionsServiceOutage")}
  ${functionSource("mentionsTechnicalIssueOrVisit")}
  ${functionSource("isOptOutMessage")}
  ${functionSource("matchPlanGroup")}
  ${functionSource("extractAccountName")}
  this.api = { formatCurrency, isBalanceQuestion, authoritativeBalanceAction, classifyInboundMessage, hasStrongReceiptEvidence, isPlausibleAccountName, isPaymentLinkRequest, isAlternativePaymentRequest, briefCourtesyReply, externalConnectivityPaymentReply, cancellationMeansPayment, extractWhatsAppMessageEchoes, isPaidQuickReply, humanizeFilename, inboundMessageText, isLikelyNotAName, classifyInstallationFragment, mentionsServiceOutage, mentionsTechnicalIssueOrVisit, isOptOutMessage, matchPlanGroup, extractAccountName };
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
assert.match(worker, /"¿Podrías aclarar un poco más a qué te refieres\?"/);
assert.match(worker, /"Parece que hay un malentendido"/);
assert.match(worker, /no a una persona real de BPGO escribiendo por WhatsApp/);
assert.match(worker, /const fallbackReply = message\.mediaId\s*\n\s*\? "Recibí tu imagen, pero no logro confirmar/);
assert.match(worker, /const known = isPlausibleAccountName\(rawKnown\) \? rawKnown : null/);
assert.match(worker, /CREATE TABLE IF NOT EXISTS whatsapp_manual_billing_sends/);
assert.match(worker, /SELECT message_id FROM whatsapp_manual_billing_sends WHERE phone = \? AND send_date = \?/);

// Debounce de ráfagas de mensajes: el bot no debe contestar cada fragmento por separado.
assert.match(worker, /const BOT_REPLY_DEBOUNCE_MS = 6000/);
assert.match(worker, /async function markLatestMessage\(env, phone, messageId\)/);
assert.match(worker, /async function isStillLatestMessage\(env, phone, messageId, waitMs = BOT_REPLY_DEBOUNCE_MS\)/);
assert.match(worker, /if \(!\(await isStillLatestMessage\(env, phone, message\.id\)\)\) continue/);

// Caso real (2026-10-01, teléfono 56937638489): "Si" y "Que valores tiene" llegaron en DOS webhooks
// separados, 10s aparte. Cada uno pasó su propio chequeo de "más nuevo" antes de llamar a la IA
// (en ese momento, cada uno de verdad lo era), pero el primero en llegar tardó más en responder
// (latencia del modelo) y para cuando terminó, el segundo ya se había marcado como más nuevo --
// el bot mandó la misma respuesta de precios dos veces. El chequeo debe repetirse SIN espera
// adicional justo antes de ejecutar la acción, para descartar la respuesta ya obsoleta.
assert.match(worker, /const action = await callBotResponder\(env, context, \{ type: message\.type \|\| "unknown", text \}, media\);[\s\S]{0,1200}if \(!\(await isStillLatestMessage\(env, phone, message\.id, 0\)\)\) continue;[\s\S]{0,50}await executeBotAction\(/);

// Sectores ya conectados (misma tarifa que Cayucupil) que no estaban en matchPlanGroup, por lo que
// un prospecto nuevo de esas zonas siempre requería aclaración manual.
for (const sector of ["Los Aromos", "La Curva", "Tres Sauces", "Fundo Anique", "Rucañire", "Cayucupil"]) {
  assert.equal(api.matchPlanGroup(sector), "cayucupil", `${sector} must map to the cayucupil plan group`);
}
for (const sector of ["Lanalhue", "Peleco", "Trangilboro", "Llenquehue"]) {
  assert.equal(api.matchPlanGroup(sector), "otros", `${sector} must map to the otros plan group`);
}
assert.equal(api.matchPlanGroup("Sector desconocido"), null);

// Caso real: el cliente antepuso una frase al nombre ("Al nombre de...", "Nombre : ...") y el bot
// lo rechazaba completo, volviendo a pedir un nombre que ya le habían dado.
assert.equal(api.isPlausibleAccountName(api.extractAccountName("Al nombre de . Pedro Rodríguez luengo")), true);
assert.equal(api.extractAccountName("Al nombre de . Pedro Rodríguez luengo"), "Pedro Rodríguez luengo");
assert.equal(api.isPlausibleAccountName(api.extractAccountName("Nombre : Pedro Rodríguez luengo")), true);
assert.equal(api.extractAccountName("Nombre : Pedro Rodríguez luengo"), "Pedro Rodríguez luengo");
assert.equal(api.extractAccountName("Mi nombre es Juan Pérez"), "Juan Pérez");
assert.equal(api.extractAccountName("Juan Pérez"), "Juan Pérez");
assert.match(worker, /if \(message\.id && message\.from\) await markLatestMessage\(env, message\.from, message\.id\)\.catch\(\(\) => null\);/);
assert.match(worker, /if \(message\.type === "reaction"\) continue;/);
assert.match(worker, /async function recentInboundMedia\(env, phone\)/);
assert.match(worker, /const carriedOver = await recentInboundMedia\(env, phone\)/);

// classifyInstallationFragment: caso real -- el cliente mandó una pregunta en vez de un dato, y
// debía descartarse en vez de quedar "anotada" como si fuera parte del nombre.
assert.equal(
  api.classifyInstallationFragment("UD. Es la misma persona que está escribiendo en el grupo de lanalhue, verdad", { name: null, address: null }),
  null,
);
assert.equal(api.classifyInstallationFragment("Ahí están los datos", { name: "Juan Chaparro", address: null }), null);

// Caso real -- el cliente mandó nombre, RUT, teléfono, correo y dirección todos juntos en un solo
// mensaje (una por línea); antes solo se rescataba el primer campo reconocido (el RUT) y el resto
// se perdía en silencio.
const allAtOnce = api.classifyInstallationFragment(
  "Juan Chaparro\n11987688-5\n+56984074598\nchaparrojuan832@gmail.com\nParcela 11 Hijuela 1 lanalhue",
  { name: null, address: null },
);
assert.equal(allAtOnce.name, "Juan Chaparro");
assert.equal(allAtOnce.rut, "11987688-5");
assert.equal(allAtOnce.phone, "+56984074598");
assert.equal(allAtOnce.email, "chaparrojuan832@gmail.com");
assert.equal(allAtOnce.address, "Parcela 11 Hijuela 1 lanalhue");

// Casos de un solo campo por mensaje (el flujo original de "ir completando de a poco") siguen
// funcionando igual.
const nameOnly = api.classifyInstallationFragment("Juan Perez", { name: null, address: null });
assert.equal(nameOnly.name, "Juan Perez");
assert.equal(Object.keys(nameOnly).length, 1);
const addressOnly = api.classifyInstallationFragment("Calle Los Aromos 123", { name: "Juan Perez", address: null });
assert.equal(addressOnly.address, "Calle Los Aromos 123");
assert.equal(Object.keys(addressOnly).length, 1);

assert.match(worker, /if \(lead\.status !== "awaiting_factibilidad"\) \{/);

// Un audio reciente no debe arrastrarse como si fuera un posible comprobante (el bot terminaba
// describiéndolo como "un documento" al cliente). Solo imagen/documento son evidencia de pago.
assert.match(worker, /AND media_id IS NOT NULL AND message_type IN \('image', 'document'\)/);
assert.match(worker, /Cuando el cliente deja claro que quiere instalarse, conectarse, o retomar\/resolver una visita/);

// Caso real: "Tiene 2 cuentas diferentes" (sobre un comprobante de pago) disparó por error la
// acción de descuento por corte de servicio. mentionsServiceOutage() debe distinguir ambos casos.
assert.equal(api.mentionsServiceOutage("Tiene 2 cuentas diferentes"), false);
assert.equal(api.mentionsServiceOutage("Llevo 3 días sin internet"), true);
assert.equal(api.mentionsServiceOutage("hubo un corte de servicio ayer"), true);
assert.match(worker, /if \(!mentionsServiceOutage\(message\.customerText\) && !mentionsServiceOutage\(action\.reason\)\) \{/);

// Mismo guard aplicado a visit_request: no crear la solicitud si nada menciona falla/visita/técnico.
assert.equal(api.mentionsTechnicalIssueOrVisit("Tiene 2 cuentas diferentes"), false);
assert.equal(api.mentionsTechnicalIssueOrVisit("el router tiene la luz roja"), true);
assert.equal(api.mentionsTechnicalIssueOrVisit("necesito que venga un técnico"), true);
assert.match(worker, /if \(!mentionsTechnicalIssueOrVisit\(message\.customerText\) && !mentionsTechnicalIssueOrVisit\(action\.reason\)\) \{/);

// Caso real: un prospecto nunca antes visto (no matchedByPhone, sin reported_name previo) pidiendo
// una "visita técnica" terminaba con "¿a nombre de quién está contratado el servicio?" -- sin
// sentido para alguien que nunca ha tenido el servicio. Debe redirigir a contratación nueva.
assert.match(worker, /if \(!known && !matchedCustomer\.matchedByPhone\) \{[\s\S]*?awaiting_sector[\s\S]*?¡Para agendar tu instalación nueva/);
assert.match(worker, /Esto incluye cuando el cliente responde a un aviso\/campaña de zona nueva habilitada/);

// Baja de servicio: debe escalar siempre, nunca resolverse sola ni prometer nada.
assert.match(worker, /Cuando SÍ sea una baja real, usa "escalate" siempre/);

// Los flujos estructurados (venta nueva, captura de nombre para visita/pago/descuento) deben
// permitir que el cliente se baje a mitad de camino en vez de tratar cualquier texto como el dato
// que se está pidiendo.
for (const value of ["ya no quiero", "mejor no, gracias", "olvídalo", "no me interesa"]) {
  assert.equal(api.isOptOutMessage(value), true, `${value} must be recognized as opting out`);
}
for (const value of ["Lanalhue", "Juan Pérez", "Calle Los Aromos 123", "no tengo internet"]) {
  assert.equal(api.isOptOutMessage(value), false, `${value} must NOT be treated as opting out`);
}
assert.match(worker, /if \(isOptOutMessage\(text\)\) \{\s*\n\s*await env\.DB\.prepare\("UPDATE whatsapp_sales_leads SET status = 'cancelled'/);
assert.match(worker, /DELETE FROM whatsapp_pending_visits WHERE phone = \?"\)\.bind\(phone\)\.run\(\);\s*\n\s*await sendBotReply\(env, credentials, phone, "Entendido, no registramos la visita/);
assert.match(worker, /DELETE FROM whatsapp_pending_payments WHERE phone = \?"\)\.bind\(phone\)\.run\(\);\s*\n\s*await sendBotReply\(env, credentials, phone, "Entendido, de todas formas dejamos tu comprobante/);
assert.match(worker, /DELETE FROM whatsapp_pending_billing WHERE phone = \?"\)\.bind\(phone\)\.run\(\);\s*\n\s*await sendBotReply\(env, credentials, phone, "Entendido, no seguimos con la revisión/);

for (const value of ["PAGO INGRESADO", "pago ingresado", "ya pagué", "hice el pago", "ingresé el pago", "pago realizado", "El pagó está hecho", "el pago ya esta realizado"]) {
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

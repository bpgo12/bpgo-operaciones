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
  ${functionSource("normalizeWhatsAppPhone")}
  ${functionSource("cyberNormalize")}
  ${functionSource("looksLikeQuestion")}
  const CYBER_INSTALL_CUTOFF = "2026-08-31";
  const CYBER_SPANISH_MONTHS = { enero: "01", febrero: "02", marzo: "03", abril: "04", mayo: "05", junio: "06", julio: "07", agosto: "08", septiembre: "09", setiembre: "09", octubre: "10", noviembre: "11", diciembre: "12" };
  ${functionSource("cyberParseInstallDate")}
  ${functionSource("cyberCandidates")}
  this.api = { formatCurrency, isBalanceQuestion, authoritativeBalanceAction, classifyInboundMessage, hasStrongReceiptEvidence, isPlausibleAccountName, isPaymentLinkRequest, isAlternativePaymentRequest, briefCourtesyReply, externalConnectivityPaymentReply, cancellationMeansPayment, extractWhatsAppMessageEchoes, isPaidQuickReply, humanizeFilename, inboundMessageText, isLikelyNotAName, classifyInstallationFragment, mentionsServiceOutage, mentionsTechnicalIssueOrVisit, isOptOutMessage, matchPlanGroup, extractAccountName, normalizeWhatsAppPhone, cyberNormalize, cyberParseInstallDate, cyberCandidates, looksLikeQuestion };
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

// Campaña Cyber (2026-10-01): la cartera operativa (app_state.customers) nunca tuvo un plan
// llamado "Oro" ni fecha de instalación ni un active/status confiable (siempre null). La fuente
// real es app_state.billingCustomers ("planilla madre" sincronizada), con monthlyAmount, plan y
// installationDate reales. Ahí "Plan Oro" ($18.000) conviven bajo DOS nombres -- "BASICO 30MB"
// (la mayoría, etiqueta heredada) y "BASICO 100MB" -- filtrar por nombre de plan en vez de precio
// dejaba fuera a la mayoría de ese nivel. El usuario además pidió limitar a instalados hasta el
// 31 de agosto de 2026 ("hay que enviárselo a todos los clientes hasta los que se instalaron hasta
// agosto"), usando esa misma fecha de instalación.
{
  const billingCustomers = [
    { id: "a", name: "Cliente Oro legado", phone: "987811014", plan: "BASICO 30MB", monthlyAmount: 18000, installationDate: "2026-07-01" },
    { id: "a2", name: "Cliente Oro nuevo nombre", phone: "911111111", plan: "BASICO 100MB", monthlyAmount: 18000, installationDate: "2026-07-01" },
    { id: "b", name: "Cliente Oro Cortado", phone: "966341140", plan: "BASICO 100MB", monthlyAmount: 18000, installationDate: "2026-07-01" },
    { id: "c", name: "Cliente Platino", phone: "937638489", plan: "FULL 300MB", monthlyAmount: 25000, installationDate: "2026-07-01" },
    { id: "d", name: "Cliente con TV mas caro", phone: "944852483", plan: "FULL 50MB +TV", monthlyAmount: 35000, installationDate: "2026-07-01" },
    { id: "f", name: "Teléfono inválido", phone: "123", plan: "BASICO 30MB", monthlyAmount: 18000, installationDate: "2026-07-01" },
    { id: "g", name: "Duplicado", phone: "987811014", plan: "BASICO 30MB", monthlyAmount: 18000, installationDate: "2026-07-01" },
    { id: "i", name: "Instalado en septiembre", phone: "922222222", plan: "BASICO 100MB", monthlyAmount: 18000, installationDate: "2026-09-01" },
    { id: "k", name: "Fecha en español", phone: "933333333", plan: "BASICO 30MB", monthlyAmount: 18000, installationDate: "24 julio 2026" },
    { id: "l", name: "Fecha irreconocible", phone: "955555555", plan: "BASICO 30MB", monthlyAmount: 18000, installationDate: "no disponible" },
  ];
  const cortados = new Set(["56966341140"]);
  const result = api.cyberCandidates({ billingCustomers }, cortados);
  // assert.deepEqual compara objetos vm vs. Node-realm por prototipo (siempre falla aunque la
  // estructura sea idéntica) -- se comparan propiedades sueltas en vez de arrays/objetos completos.
  assert.equal(result.selected.some((x) => x.id === "a"), true, "BASICO 30MB a $18.000 es Plan Oro aunque el nombre sea el heredado");
  assert.equal(result.selected.some((x) => x.id === "a2"), true, "BASICO 100MB a $18.000 también es Plan Oro");
  assert.equal(result.selected.some((x) => x.id === "k"), true, "fecha en español (24 julio 2026) debe parsear e incluirse");
  const excludedB = result.excluded.find((x) => x.id === "b");
  assert.equal(excludedB?.reason, "inactive");
  const excludedF = result.excluded.find((x) => x.id === "f");
  assert.equal(excludedF?.reason, "invalid_phone");
  const excludedG = result.excluded.find((x) => x.id === "g");
  assert.equal(excludedG?.reason, "duplicate");
  const excludedI = result.excluded.find((x) => x.id === "i");
  assert.equal(excludedI?.reason, "installed_after_cutoff", "instalado en septiembre (después del corte) debe excluirse");
  const excludedL = result.excluded.find((x) => x.id === "l");
  assert.equal(excludedL?.reason, "installation_date_unknown", "fecha irreconocible no debe compararse como texto, se marca para revisión");
  assert.equal(result.selected.some((x) => x.id === "c"), false, "FULL 300MB ($25.000) no es Plan Oro");
  assert.equal(result.selected.some((x) => x.id === "d"), false, "FULL 50MB +TV ($35.000) no es Plan Oro");
  // Sin la lista de cortados (sync caído) no se debe asumir que nadie está cortado -- cyberSnapshot
  // marca cortadosCheckFailed y sendCyberCampaign rechaza el envío en ese caso.
  const noSync = api.cyberCandidates({ billingCustomers }, undefined);
  assert.equal(noSync.selected.some((x) => x.id === "b"), true);
}
assert.equal(api.cyberParseInstallDate("2026-08-31"), "2026-08-31");
assert.equal(api.cyberParseInstallDate("24 julio 2026"), "2026-07-24");
assert.equal(api.cyberParseInstallDate("no disponible"), null);
assert.match(worker, /async function cortadosPhoneSet\(\)/);
assert.match(worker, /cortadosCheckFailed: cortados === null/);
assert.match(worker, /if \(snapshot\.cortadosCheckFailed\) throw new Error\("No se pudo verificar la lista de clientes cortados/);

// Caso real (2026-10-01, teléfono 56937638489): "Si" y "Que valores tiene" llegaron en DOS webhooks
// separados, 10s aparte. Cada uno pasó su propio chequeo de "más nuevo" antes de llamar a la IA
// (en ese momento, cada uno de verdad lo era), pero el primero en llegar tardó más en responder
// (latencia del modelo) y para cuando terminó, el segundo ya se había marcado como más nuevo --
// el bot mandó la misma respuesta de precios dos veces. El chequeo debe repetirse SIN espera
// adicional justo antes de ejecutar la acción, para descartar la respuesta ya obsoleta.
assert.match(worker, /const action = await callBotResponder\(env, context, \{ type: message\.type \|\| "unknown", text \}, media\);[\s\S]{0,1200}if \(!\(await isStillLatestMessage\(env, phone, message\.id, 0\)\)\) continue;[\s\S]{0,50}await executeBotAction\(/);

// Sectores ya conectados (misma tarifa que Cayucupil) que no estaban en matchPlanGroup, por lo que
// un prospecto nuevo de esas zonas siempre requería aclaración manual.
for (const sector of ["Los Aromos", "La Curva", "Tres Sauces", "Fundo Anique", "Rucañire", "Cayucupil", "Cañete"]) {
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

// Caso real (2026-10-02, 56990934462): clienta con instalación ya programada para ese día preguntó
// "para cuándo nos van a visitar" y el bot la trató como prospecto nuevo, pidiéndole ubicación 5 veces.
assert.match(worker, /const install = await findScheduledInstallation\(env, phone\)\.catch\(\(\) => null\);\s*\n\s*if \(install\?\.plannedDate\)/);
assert.match(worker, /if \(\(reminded\?\.n \|\| 0\) >= 1\) \{[\s\S]{0,900}setBotSessionMode\(env, phone, "human", "case_created_new_customer"\)/);
{
  const ctx = { Intl, Date, Set, Array, String, Number };
  vm.createContext(ctx);
  vm.runInContext(`
    const SPANISH_MONTH_NAMES = [];
    const SCHEDULED_INSTALL_STATUSES = ["Programada", "Instalacion Programada", "Confirmada"];
    ${functionSource("normalizeWhatsAppPhone")}
    ${functionSource("normalizeComparablePhone")}
    ${functionSource("chileDateParts")}
    async ${functionSource("findScheduledInstallation")}
    ${functionSource("describeInstallDate")}
    this.api = { findScheduledInstallation, describeInstallDate };
  `, ctx);
  const state = {
    customers: [{ id: "c1", phone: "990934462 " }],
    billingCustomers: [],
    workOrders: [
      { type: "Instalacion", customerId: "c1", status: "Programada", plannedDate: "2999-01-01" },
      { type: "Instalacion", customerId: "c1", status: "Finalizado", plannedDate: "2999-01-02" },
    ],
  };
  const env = { DB: { prepare: () => ({ first: async () => ({ data: JSON.stringify(state) }) }) } };
  Promise.all([ctx.api.findScheduledInstallation(env, "56990934462"), ctx.api.findScheduledInstallation(env, "56911112222")])
    .then(([found, unknown]) => {
      assert.equal(found.plannedDate, "2999-01-01");
      assert.equal(unknown.knownCustomer, false);
    })
    .catch((error) => { console.error(error); process.exit(1); });
  assert.equal(ctx.api.describeInstallDate("2026-10-02", "2026-10-02"), "hoy");
  assert.match(ctx.api.describeInstallDate("2026-10-03", "2026-10-02"), /sábado 3 de octubre/);
}

// Caso real (2026-10-02, +56 9 3763 8489): la clienta preguntó si el costo de instalación "se paga en
// la boleta" y la IA respondió que sí (inventado). La política real: se paga AL MOMENTO de la
// instalación junto con el mes proporcional por adelantado; nunca en la boleta.
{
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(`
    ${functionSource("cyberNormalize")}
    ${functionSource("isInstallationPaymentQuestion")}
    this.api = { isInstallationPaymentQuestion };
  `, ctx);
  for (const yes of ["¿La instalación se paga en la boleta?", "cuanto cuesta la instalacion", "Cuánto es el costo de instalar", "como pago la instalación"]) {
    assert.equal(ctx.api.isInstallationPaymentQuestion(yes), true, yes);
  }
  for (const no of ["¿Cuánto demora la instalación?", "Pagué la instalación, te envío el comprobante", "Quiero la instalación para hoy", "el de 50mb"]) {
    assert.equal(ctx.api.isInstallationPaymentQuestion(no), false, no);
  }
}
assert.match(worker, /const INSTALLATION_PAYMENT_POLICY = `📌 Al momento de la instalación se debe pagar el costo de instalación/);
assert.match(worker, /function planConfirmationMessage[\s\S]{0,700}\$\{INSTALLATION_PAYMENT_POLICY\}/);
assert.match(worker, /Política de pago de la INSTALACIÓN[\s\S]{0,400}NUNCA se cobran en la boleta/);
assert.match(worker, /isInstallationPaymentQuestion\(text\) \|\| salesLeadPaying\)\) \{\s*\n\s*await sendBotReply\(env, credentials, phone, `Al momento de la instalación se paga[\s\S]{0,300}No se cobra en la boleta/);

// Caso real (2026-10-02, 56985843355): un saludo ("Buenos dias") contestó la pregunta "¿a nombre de
// quién está contratado?" de una visita pendiente y quedó registrada la solicitud a nombre de "Buenos dias".
for (const greeting of ["Buenos dias", "Buenas tardes", "Hola buenas", "Buenos días", "Consulta tenía hora"]) {
  assert.equal(api.isPlausibleAccountName(api.extractAccountName(greeting)), false, `${greeting} no es un nombre`);
}
assert.equal(api.isPlausibleAccountName("Pedro Rodríguez Luengo"), true);
assert.equal(api.isPlausibleAccountName("Buenaventura Soto"), true);
assert.match(worker, /if \(message\.id && message\.from\) await markLatestMessage\(env, message\.from, message\.id\)\.catch\(\(\) => null\);/);
assert.match(worker, /if \(message\.type === "reaction"\) continue;/);
assert.match(worker, /async function recentInboundMedia\(env, phone\)/);
assert.match(worker, /const carriedOver = await recentInboundMedia\(env, phone\)/);

// Caso real (2026-10-01, teléfono 56994955003): con factibilidad confirmada y los planes ya
// enviados, la clienta preguntó "Debo cancelar en el momento q instalen los 25" en vez de nombrar
// un plan. matchChosenPlan no reconoce nada (el "25" suelto no calza con ninguna velocidad: 100,
// 300 ni 500), así que el bot reenviaba el MISMO mensaje "¡Buenas noticias!..." de factibilidad --
// para la clienta se veía como que el bot le mandó dos veces seguidas lo mismo. Una pregunta debe
// escalarse a un agente, no repetirse el anuncio completo como si no hubiera dicho nada.
assert.equal(api.looksLikeQuestion("Debo cancelar en el momento q instalen los 25"), true);
assert.equal(api.looksLikeQuestion("¿Cuánto demora la instalación?"), true);
assert.equal(api.looksLikeQuestion("300mb/s"), false);
assert.equal(api.looksLikeQuestion("el de 25.000"), false);
assert.match(worker, /function formatPlanReminderMessage\(groupKey\)/);
assert.match(worker, /else if \(looksLikeQuestion\(text\)\) \{[\s\S]{0,400}sourceMessageId: message\.id \}\);[\s\S]{0,150}setBotSessionMode\(env, phone, "human", "case_created_new_customer"\);/);

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

// Plantilla de respaldo solo texto (2026-10-02): la v2 con banner llevaba >1 día en revisión. La de
// respaldo comparte campaña/botones pero NO puede repetir el cuerpo (Meta rechaza duplicados) ni
// llevar encabezado de imagen, y debe respetar los límites de Meta (cuerpo 1024, botón 25).
{
  const start = worker.indexOf("const CYBER_UPGRADE = Object.freeze");
  const end = worker.indexOf("function cyberIsOpen");
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(`${worker.slice(start, end)}\nthis.api = { CYBER_UPGRADE, CYBER_TEMPLATE_VARIANTS };`, ctx);
  const { CYBER_UPGRADE, CYBER_TEMPLATE_VARIANTS } = ctx.api;
  assert.equal(CYBER_TEMPLATE_VARIANTS.image.template, CYBER_UPGRADE.template);
  assert.equal(CYBER_TEMPLATE_VARIANTS.image.header, true);
  assert.equal(CYBER_TEMPLATE_VARIANTS.text.header, false);
  assert.notEqual(CYBER_TEMPLATE_VARIANTS.text.template, CYBER_TEMPLATE_VARIANTS.image.template);
  assert.notEqual(CYBER_TEMPLATE_VARIANTS.text.text, CYBER_TEMPLATE_VARIANTS.image.text);
  assert.match(CYBER_TEMPLATE_VARIANTS.text.template, /^[a-z0-9_]+$/);
  assert.ok(CYBER_TEMPLATE_VARIANTS.text.text.length <= 1024);
  assert.doesNotMatch(CYBER_TEMPLATE_VARIANTS.text.text, /\{\{/);
  assert.match(CYBER_TEMPLATE_VARIANTS.text.text, /21\.990/);
  assert.match(CYBER_TEMPLATE_VARIANTS.text.text, /5 de octubre/);
  assert.ok(CYBER_UPGRADE.buttons.every((b) => b.length <= 25));
}
assert.match(worker, /\.\.\.\(v\.header \? \[\{ type: "HEADER", format: "IMAGE"/);
assert.match(worker, /\.\.\.\(sendVariant\.header \? \[\{ type: "header"/);
assert.match(worker, /name: sendVariant\.template/);
assert.match(worker, /const active = image\.ready \? image : text\.ready \? text : null;/);

// 2026-10-02: Carlos decidió que la atención humana NO excluye de la campaña Cyber (la marca "human" es
// casi siempre residual: 91 comprobantes de pago nunca se desmarcan). Por eso (a) ni el snapshot ni el
// envío filtran por modo humano, y (b) el botón de un cliente en modo humano se atiende ANTES del filtro
// que descarta sus mensajes, o su respuesta se perdería sin avisarle a Carlos.
assert.match(worker, /const eligible = candidates\.selected\.filter\(\(x\) => !attempted\.has\(x\.phone\)\);/);
assert.match(worker, /humanExcluded: 0, humanIncluded:/);
assert.match(worker, /if \(!cyberIsOpen\(\)\) \{\s*\n\s*results\.push\(\{ phone, status: "skipped" \}\)/);
assert.doesNotMatch(worker, /await getBotSessionMode\(env, phone\) === "human"\) \{\s*\n\s*results\.push/);
assert.match(worker, /if \(await handleCyberReply\(env, credentials, message\)\) continue;\s*\n\s*const sessionRow = await getBotSessionRow\(env, phone\);/);
assert.match(worker, /if \(!alreadyHuman\) await setBotSessionMode\(env, message\.from, "human", `cyber_upgrade_\$\{response\}`\);/);

// 2026-10-03: quien presiona "Me interesa"/"Hablar con ejecutivo" recibe un acuse en texto libre (dentro de
// la ventana de 24 h, sin depender de plantillas). Fuera de plazo no se promete el precio promocional.
assert.match(worker, /const ack = response === "interested"\s*\n\s*\? "¡Excelente! 🎉 Recibimos tu solicitud[^"]*\$21\.990\/mes durante 6 meses[^"]*"\s*\n\s*: response === "human"[\s\S]{0,400}: "Gracias por escribirnos\. La promoción Cyber ya terminó;/);
assert.match(worker, /await sendWhatsAppText\(env, credentials, message\.from, ack\)\.catch\(\(\) => null\);/);

// Casos reales (2026-10-05): (1) un cliente en modo humano escribió pidiendo un ejecutivo y nadie se enteró
// -> aviso a Carlos con cooldown; (2) en una prueba desde un número personal el bot repetía sin parar la lista
// de planes y "no olvidaba" la conversación -> tope tras un recordatorio + comando para empezar de nuevo.
assert.match(worker, /await alertStaffCustomerWroteInHumanMode\(env, credentials, phone, message\)\.catch\(\(\) => null\);\s*\n\s*continue;/);
assert.match(worker, /case_type = 'Cliente en atención humana'/);
assert.match(worker, /const HUMAN_MODE_ALERT_COOLDOWN_MIN = 60;/);
assert.match(worker, /if \(\(planReminders\?\.n \|\| 0\) >= 1\) \{[\s\S]{0,300}te va a escribir un agente[\s\S]{0,600}setBotSessionMode\(env, phone, "human", "case_created_new_customer"\)/);
assert.match(worker, /Ese plan no está disponible en tu sector\./);
assert.match(worker, /if \(lastOut\?\.message_text !== FACTIBILIDAD_WAIT\)/);
{
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(`
    ${functionSource("cyberNormalize")}
    ${functionSource("isRestartRequest")}
    this.api = { isRestartRequest };
  `, ctx);
  for (const yes of ["Empezar de nuevo", "quiero volver a empezar", "reinicia la conversación", "olvida todo", "Desde cero por favor"]) {
    assert.equal(ctx.api.isRestartRequest(yes), true, yes);
  }
  for (const no of ["reinicié el router", "ya hice el reinicio del router", "reinicia el router", "Quiero contratar", "Plan 30mb/s"]) {
    assert.equal(ctx.api.isRestartRequest(no), false, no);
  }
}

// Regla de Carlos (2026-10-05): si nadie atiende a un cliente en modo humano por unos minutos, el bot retoma.
// Solo si el ÚLTIMO mensaje es del cliente (texto), sin respuesta >= 10 min, y el modo humano tampoco se fijó
// en ese lapso; nunca con adjuntos ni con simples cierres de cortesía; una sola vez por mensaje.
assert.match(worker, /const HUMAN_NO_RESPONSE_TAKEOVER_MS = 10 \* 60 \* 1000;/);
assert.match(worker, /m\.created_at = \(SELECT MAX\(created_at\) FROM whatsapp_inbox_messages WHERE phone = s\.phone\)/);
assert.match(worker, /m\.message_type = 'text'/);
assert.match(worker, /s\.updated_at <= \?/);
assert.match(worker, /claimInboundMessageForBot\(env, `retake:\$\{row\.message_id\}`\)/);
assert.match(worker, /setBotSessionMode\(env, row\.phone, "bot", "auto_reactivated_unanswered"\)/);
assert.match(worker, /const takeoverTask = takeOverUnansweredHumanChats\(env\)\.catch\(\(\) => null\);/);
assert.match(worker, /const takeover = await takeOverUnansweredHumanChats\(env\)/);
{
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(`
    ${functionSource("cyberNormalize")}
    ${functionSource("isClosingPleasantry")}
    this.api = { isClosingPleasantry };
  `, ctx);
  for (const yes of ["Ya perfecto gracias", "Gracias", "ok listo", "Muchas gracias!", "👍 gracias"]) {
    assert.equal(ctx.api.isClosingPleasantry(yes), true, yes);
  }
  for (const no of ["Buen día pago de Sergio catrileo jara", "Gracias pero sigo sin internet", "Hola", "Buenos días mi", "Algún ejecutivo para hablar"]) {
    assert.equal(ctx.api.isClosingPleasantry(no), false, no);
  }
}

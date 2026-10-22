"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const worker = fs.readFileSync(path.join(__dirname, "..", "_worker.js"), "utf8");

// Constantes y funciones auxiliares del lector de datos de instalación (se inyectan antes de classifyInstallationFragment).
function topLevelConst(name) {
  const start = worker.indexOf(`const ${name} =`);
  let depth = 0;
  for (let i = start; i < worker.length; i += 1) {
    const c = worker[i];
    if ("[({".includes(c)) depth += 1;
    else if ("])}".includes(c)) depth -= 1;
    else if (c === ";" && depth === 0) return worker.slice(start, i + 1);
  }
  throw new Error(`unterminated ${name}`);
}
const installationParserDeps = () => ["INSTALLATION_SECTORS", "INSTALLATION_ADDRESS_WORDS", "INSTALLATION_CHAT_WORDS", "INSTALLATION_NAME_STOPWORDS",
  "INSTALLATION_LABELS", "INSTALLATION_COMMON_WORDS", "INSTALLATION_NAME_PARTICLES"].map(topLevelConst).join("\n") + "\n" +
  ["installationPlain", "installationRutCheckDigit", "normalizeInstallationRut", "normalizeInstallationPhone", "isInstallationName", "isInstallationAddress"].map(functionSource).join("\n");

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
  ${functionSource("isNameLikeFragment")}
  ${installationParserDeps()}
  ${functionSource("classifyInstallationFragment")}
  ${functionSource("mentionsServiceOutage")}
  ${functionSource("mentionsTechnicalIssueOrVisit")}
  ${functionSource("isOptOutMessage")}
  ${functionSource("matchPlanGroup")}
  ${functionSource("extractAccountName")}
  ${functionSource("normalizeWhatsAppPhone")}
  ${functionSource("cyberNormalize")}
  ${functionSource("botTextProblem")}
  ${functionSource("looksLikeQuestion")}
  const CYBER_INSTALL_CUTOFF = "2026-08-31";
  const CYBER_SPANISH_MONTHS = { enero: "01", febrero: "02", marzo: "03", abril: "04", mayo: "05", junio: "06", julio: "07", agosto: "08", septiembre: "09", setiembre: "09", octubre: "10", noviembre: "11", diciembre: "12" };
  ${functionSource("cyberParseInstallDate")}
  ${functionSource("cyberCandidates")}
  this.api = { formatCurrency, isBalanceQuestion, authoritativeBalanceAction, classifyInboundMessage, hasStrongReceiptEvidence, isPlausibleAccountName, isPaymentLinkRequest, isAlternativePaymentRequest, briefCourtesyReply, externalConnectivityPaymentReply, cancellationMeansPayment, extractWhatsAppMessageEchoes, isPaidQuickReply, humanizeFilename, inboundMessageText, isLikelyNotAName, classifyInstallationFragment, mentionsServiceOutage, mentionsTechnicalIssueOrVisit, isOptOutMessage, matchPlanGroup, extractAccountName, normalizeWhatsAppPhone, cyberNormalize, cyberParseInstallDate, cyberCandidates, looksLikeQuestion, botTextProblem };
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
assert.equal(api.botTextProblem("No se pueden cambiar las fechas de pago."), "unsupported_policy");
assert.equal(api.botTextProblem("No está permitido modificar el día de pago."), "unsupported_policy");
assert.equal(api.botTextProblem("Tu comprobante está en revisión."), null);
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
// 2026-10-15 (Carlos): una foto no es necesariamente un comprobante -> respuesta neutra, sin mencionar pagos.
assert.match(worker, /const fallbackReply = message\.mediaId\s*\n\s*\? "Recibí tu imagen 👍 ¿Me cuentas en qué te puedo ayudar con ella\?"/);
assert.match(worker, /action = \{ action: "reply", text: "Recibí tu imagen 👍 ¿Me cuentas en qué te puedo ayudar con ella\?" \};/);
assert.doesNotMatch(worker, /Si es un comprobante de pago, el equipo lo revisará/);
assert.match(worker, /Una foto cualquiera \(router, luces, casa, cables, pantalla, persona, captura de otra cosa\) NO es un comprobante/);
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
    { id: "a", name: "Cliente Oro legado", phone: "912000030", plan: "BASICO 30MB", monthlyAmount: 18000, installationDate: "2026-07-01" },
    { id: "a2", name: "Cliente Oro nuevo nombre", phone: "911111111", plan: "BASICO 100MB", monthlyAmount: 18000, installationDate: "2026-07-01" },
    { id: "b", name: "Cliente Oro Cortado", phone: "912000020", plan: "BASICO 100MB", monthlyAmount: 18000, installationDate: "2026-07-01" },
    { id: "c", name: "Cliente Platino", phone: "912000005", plan: "FULL 300MB", monthlyAmount: 25000, installationDate: "2026-07-01" },
    { id: "d", name: "Cliente con TV mas caro", phone: "912000008", plan: "FULL 50MB +TV", monthlyAmount: 35000, installationDate: "2026-07-01" },
    { id: "f", name: "Teléfono inválido", phone: "123", plan: "BASICO 30MB", monthlyAmount: 18000, installationDate: "2026-07-01" },
    { id: "g", name: "Duplicado", phone: "912000030", plan: "BASICO 30MB", monthlyAmount: 18000, installationDate: "2026-07-01" },
    { id: "i", name: "Instalado en septiembre", phone: "922222222", plan: "BASICO 100MB", monthlyAmount: 18000, installationDate: "2026-09-01" },
    { id: "k", name: "Fecha en español", phone: "933333333", plan: "BASICO 30MB", monthlyAmount: 18000, installationDate: "24 julio 2026" },
    { id: "l", name: "Fecha irreconocible", phone: "955555555", plan: "BASICO 30MB", monthlyAmount: 18000, installationDate: "no disponible" },
  ];
  const cortados = new Set(["56912000020"]);
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
assert.match(worker, /async function cortadosPhoneSet\(env\)/);
assert.match(worker, /cortadosCheckFailed: cortados === null/);
assert.match(worker, /if \(snapshot\.cortadosCheckFailed\) throw new Error\("No se pudo verificar la lista de clientes cortados/);

// Caso real (2026-10-01, teléfono 56912000005): "Si" y "Que valores tiene" llegaron en DOS webhooks
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
assert.equal(api.isPlausibleAccountName(api.extractAccountName("Al nombre de . Pablo Luengo Rios")), true);
assert.equal(api.extractAccountName("Al nombre de . Pablo Luengo Rios"), "Pablo Luengo Rios");
assert.equal(api.isPlausibleAccountName(api.extractAccountName("Nombre : Pablo Luengo Rios")), true);
assert.equal(api.extractAccountName("Nombre : Pablo Luengo Rios"), "Pablo Luengo Rios");
assert.equal(api.extractAccountName("Mi nombre es Juan Pérez"), "Juan Pérez");
assert.equal(api.extractAccountName("Juan Pérez"), "Juan Pérez");

// Caso real (2026-10-02, 56912000032): clienta con instalación ya programada para ese día preguntó
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
    customers: [{ id: "c1", phone: "912000032 " }],
    billingCustomers: [],
    workOrders: [
      { type: "Instalacion", customerId: "c1", status: "Programada", plannedDate: "2999-01-01" },
      { type: "Instalacion", customerId: "c1", status: "Finalizado", plannedDate: "2999-01-02" },
    ],
  };
  const env = { DB: { prepare: () => ({ first: async () => ({ data: JSON.stringify(state) }) }) } };
  Promise.all([ctx.api.findScheduledInstallation(env, "56912000032"), ctx.api.findScheduledInstallation(env, "56911112222")])
    .then(([found, unknown]) => {
      assert.equal(found.plannedDate, "2999-01-01");
      assert.equal(unknown.knownCustomer, false);
    })
    .catch((error) => { console.error(error); process.exit(1); });
  assert.equal(ctx.api.describeInstallDate("2026-10-02", "2026-10-02"), "hoy");
  assert.match(ctx.api.describeInstallDate("2026-10-03", "2026-10-02"), /sábado 3 de octubre/);
}

// Caso real (2026-10-02, +56 9 1200 0005): la clienta preguntó si el costo de instalación "se paga en
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

// Caso real (2026-10-02, 56912000026): un saludo ("Buenos dias") contestó la pregunta "¿a nombre de
// quién está contratado?" de una visita pendiente y quedó registrada la solicitud a nombre de "Buenos dias".
for (const greeting of ["Buenos dias", "Buenas tardes", "Hola buenas", "Buenos días", "Consulta tenía hora"]) {
  assert.equal(api.isPlausibleAccountName(api.extractAccountName(greeting)), false, `${greeting} no es un nombre`);
}
assert.equal(api.isPlausibleAccountName("Pablo Luengo Rios"), true);
assert.equal(api.isPlausibleAccountName("Buenaventura Soto"), true);
assert.match(worker, /if \(message\.id && message\.from\) await markLatestMessage\(env, message\.from, message\.id\)\.catch\(\(\) => null\);/);
assert.match(worker, /if \(message\.type === "reaction"\) continue;/);
assert.match(worker, /async function recentInboundMedia\(env, phone\)/);
assert.match(worker, /const carriedOver = await recentInboundMedia\(env, phone\)/);

// Caso real (2026-10-01, teléfono 56912000034): con factibilidad confirmada y los planes ya
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
assert.equal(api.classifyInstallationFragment("Ahí están los datos", { name: "Juan Paz", address: null }), null);

// Caso real -- el cliente mandó nombre, RUT, teléfono, correo y dirección todos juntos en un solo
// mensaje (una por línea); antes solo se rescataba el primer campo reconocido (el RUT) y el resto
// se perdía en silencio.
const allAtOnce = api.classifyInstallationFragment(
  "Juan Paz\n10158380-5\n+56912000024\ncliente2@ejemplo.cl\nParcela 11 Hijuela 1 lanalhue",
  { name: null, address: null },
);
assert.equal(allAtOnce.name, "Juan Paz");
assert.equal(allAtOnce.rut, "10158380-5");
assert.equal(allAtOnce.phone, "+56912000024");
assert.equal(allAtOnce.email, "cliente2@ejemplo.cl");
assert.equal(allAtOnce.address, "Parcela 11 Hijuela 1 lanalhue");

// Casos de un solo campo por mensaje (el flujo original de "ir completando de a poco") siguen
// funcionando igual.
const nameOnly = api.classifyInstallationFragment("Juan Perez", { name: null, address: null });
assert.equal(nameOnly.name, "Juan Perez");
assert.equal(Object.keys(nameOnly).length, 1);
const addressOnly = api.classifyInstallationFragment("Calle Los Aromos 123", { name: "Juan Perez", address: null });
assert.equal(addressOnly.address, "Calle Los Aromos 123");
assert.equal(Object.keys(addressOnly).length, 1);

assert.match(worker, /if \(!allowedStatuses\.includes\(lead\.status\)\) \{/);
assert.match(worker, /await applyFactibilidadDecision\(env, credentials, phone, lead, isYes\);/);
// 2026-10-19: Carlos responde a mano "sí hay factibilidad" y el sistema se lo avisa al cliente (planes), sin que el bot le conteste a él.
{
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(`
    function cyberNormalize(value) { return String(value || "").normalize("NFD").replace(/[\\u0300-\\u036f]/g, "").toLowerCase(); }
    ${functionSource("staffFactibilidadDecision")}
    this.api = { staffFactibilidadDecision };
  `, ctx);
  assert.equal(ctx.api.staffFactibilidadDecision("si tenemos factibilidad"), "yes");
  assert.equal(ctx.api.staffFactibilidadDecision("Sí hay factibilidad"), "yes");
  assert.equal(ctx.api.staffFactibilidadDecision("si hay"), "yes");
  assert.equal(ctx.api.staffFactibilidadDecision("hay factibilidad"), "yes");
  assert.equal(ctx.api.staffFactibilidadDecision("no hay factibilidad"), "no");
  assert.equal(ctx.api.staffFactibilidadDecision("no hay"), "no");
  assert.equal(ctx.api.staffFactibilidadDecision("sin factibilidad"), "no");
  assert.equal(ctx.api.staffFactibilidadDecision("¿hay factibilidad en peleco?"), null);
  assert.equal(ctx.api.staffFactibilidadDecision("hola, cuánto debe el cliente"), null);
  assert.equal(ctx.api.staffFactibilidadDecision("cayucupil"), null);
}
assert.match(worker, /const decision = staffFactibilidadDecision\(message\.text\?\.body\);/);
assert.match(worker, /await applyFactibilidadDecision\(env, credentials, phone, target, decision === "yes", pendingStatuses\);/);

// Un audio reciente no debe arrastrarse como si fuera un posible comprobante (el bot terminaba
// describiéndolo como "un documento" al cliente). Solo imagen/documento son evidencia de pago.
assert.match(worker, /AND media_id IS NOT NULL AND message_type IN \('image', 'document'\)/);
assert.match(worker, /Cuando el cliente deja claro que quiere instalarse, conectarse, o retomar\/resolver una visita/);

// Caso real: "Tiene 2 cuentas diferentes" (sobre un comprobante de pago) disparó por error la
// acción de descuento por corte de servicio. mentionsServiceOutage() debe distinguir ambos casos.
assert.equal(api.mentionsServiceOutage("Tiene 2 cuentas diferentes"), false);
assert.equal(api.mentionsServiceOutage("Llevo 3 días sin internet"), true);
assert.equal(api.mentionsServiceOutage("hubo un corte de servicio ayer"), true);
// 2026-10-20 (56912000022): la solicitud de descuento por corte exige palabras del PROPIO cliente, no solo el resumen del modelo.
assert.match(worker, /if \(!mentionsServiceOutage\(message\.customerText\) && !mentionsServiceOutage\(recentCustomerWords\)\) \{/);
assert.doesNotMatch(worker, /!mentionsServiceOutage\(action\.reason\)/);
// 2026-10-20 (56912000019): nombre + RUT + mes en la misma frase.
{
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(`${functionSource("extractAccountName")}; ${functionSource("isPlausibleAccountName")}; this.api = { extractAccountName, isPlausibleAccountName };`, ctx);
  const n = (v) => ctx.api.extractAccountName(v);
  assert.equal(n("Oscar Varela Solis, 12.345.678-5, mes de octubre 2026"), "Oscar Varela Solis");
  assert.equal(n("Oscar Varela Solis, 12.345.678-5"), "Oscar Varela Solis");
  assert.equal(n("a nombre de Juan Pérez"), "Juan Pérez");
  assert.equal(ctx.api.isPlausibleAccountName(n("Oscar Varela Solis, 12.345.678-5, mes de octubre 2026")), true);
  assert.equal(ctx.api.isPlausibleAccountName(n("ya pagué")), false);
}
// 2026-10-20 (56912000022): "No ya cansele" = ya pagué, no una baja del servicio.
assert.match(worker, /\(cancele\|cansele\|cancelee\|cancelado\|cancelada\|cancelamos\|canselamos\)/);
assert.match(worker, /const captionName = extractAccountName\(message\.customerText\);/);

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
// 2026-10-15: Carlos ya no quiere el aviso "Cliente en atención humana" por ningún mensaje (ni imágenes).
assert.doesNotMatch(worker, /alertStaffCustomerWroteInHumanMode/);
assert.doesNotMatch(worker, /notifyStaff\([^)]*"Cliente en atención humana"/);
assert.doesNotMatch(worker, /Envió un mensaje \(\$\{message\.type/);
assert.match(worker, /m\.message_type IN \('image', 'document'\)\s*\n\s*AND m\.created_at <=/);
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
assert.match(worker, /const HUMAN_NO_RESPONSE_TAKEOVER_MS = 5 \* 60 \* 1000;/);
assert.match(worker, /m\.created_at = \(SELECT MAX\(created_at\) FROM whatsapp_inbox_messages WHERE phone = s\.phone\)/);
assert.match(worker, /m\.message_type = 'text'/);
assert.match(worker, /s\.updated_at <= \?/);
assert.match(worker, /claimInboundMessageForBot\(env, `retake-claim:\$\{row\.message_id\}`\)/);
// El claim de la retoma NO puede usar el mismo id que el mensaje sintético (`retake:<id>`): runBotForInboundMessages
// lo reclama de nuevo y, al verlo ya procesado, se saltaría el mensaje sin responder (bug real 2026-10-05).
assert.doesNotMatch(worker, /claimInboundMessageForBot\(env, `retake:/);
assert.match(worker, /id: `retake:\$\{row\.message_id\}`, from: row\.phone/);
assert.match(worker, /setBotSessionMode\(env, row\.phone, "bot", "auto_reactivated_unanswered"\)/);
assert.match(worker, /const takeoverTask = takeOverUnansweredHumanChats\(env\)\.then\(\(\) => resumeAfterHoursChats\(env\)\)\s*\n\s*\.then\(\(\) => runBillingAutomationIfDue\(env\)\)\s*\n\s*\.then\(\(\) => \{ if \(Date\.now\(\) - lastReminderV2CheckMs < 10 \* 60 \* 1000\) return null;/);
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
  for (const no of ["Buen día pago de Simon Cayul Jerez", "Gracias pero sigo sin internet", "Hola", "Buenos días mi", "Algún ejecutivo para hablar"]) {
    assert.equal(ctx.api.isClosingPleasantry(no), false, no);
  }
}

// ---- Auditoría 2026-10-05 ----
// (1) Bucle con otro bot (22+ mensajes con un número que respondía ofertas de Movistar): no responder a
// respuestas automáticas + tope de mensajes por teléfono/ventana.
{
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(`
    ${functionSource("cyberNormalize")}
    ${functionSource("isLikelyAutoReply")}
    ${functionSource("isClosingPleasantry")}
    this.api = { isLikelyAutoReply, isClosingPleasantry };
  `, ctx);
  for (const yes of ["¡Hola, que alegría verte por acá! 😍 Descubre las ofertas para ti", "¡Ningún problema! Te avisaremos en otra ocasión cuando tengamos más ofertas exclusivas para ti",
    "Este es un mensaje automático, no responder", "Gracias por contactarnos. Nuestro horario de atención es de 9 a 18"]) {
    assert.equal(ctx.api.isLikelyAutoReply(yes), true, yes);
  }
  for (const no of ["Hola, no tengo internet", "Quiero contratar el plan de 300", "Buenos días, necesito ayuda con mi pago", "Me interesa"]) {
    assert.equal(ctx.api.isLikelyAutoReply(no), false, no);
  }
}
assert.match(worker, /const BOT_LOOP_MAX_REPLIES = 24;/);
// Un embudo de venta normal envía 8+ mensajes en 10 minutos: el freno debe basarse en mensajes ENTRANTES repetidos.
assert.match(worker, /const BOT_LOOP_REPEATED_INBOUND = 3;/);
assert.match(worker, /\(repeated\?\.n \|\| 0\) < BOT_LOOP_REPEATED_INBOUND && \(recent\?\.n \|\| 0\) < BOT_LOOP_MAX_REPLIES/);
assert.match(worker, /if \(!isStaffPhone && await guardAgainstBotLoop\(env, credentials, phone, message\)\) continue;/);
assert.match(worker, /setBotSessionMode\(env, phone, "human", "bot_loop_suspected"\)/);
// (2) Chats sin responder: resumen a Carlos + ventana de retoma hasta 23 h (límite de WhatsApp).
assert.match(worker, /const HUMAN_NO_RESPONSE_MAX_AGE_MS = 23 \* 60 \* 60 \* 1000;/);
assert.match(worker, /async function alertStaffUnansweredChats\(env\)/);
// 2026-10-10: Carlos pidió eliminar el resumen "Chats sin responder" (llegaba a cada rato): ya no se llama.
assert.doesNotMatch(worker, /await alertStaffUnansweredChats\(env\)/);
assert.match(worker, /const digest = \{ ok: true, sent: false, reason: "disabled" \};/);
assert.match(worker, /case_type = 'Chats sin responder'/);
// (3) Avisos fallidos por 131042 se reintentan solos (24 h, 30 min entre intentos).
assert.match(worker, /status = 'failed' AND error_code = '131042' AND created_at > datetime\('now', '-24 hours'\)/);
assert.match(worker, /last_attempt_at < datetime\('now', '-30 minutes'\)/);
// (4) Sin META_APP_SECRET no se ejecuta un "Registrar pago" falsificable desde el webhook.
assert.match(worker, /if \(!env\.META_APP_SECRET\) \{[\s\S]{0,700}confirm_payment:[\s\S]{0,200}unsigned_webhook_payment_action_dropped/);
// (5) IA con timeout; el pago aplicado no pisa cambios concurrentes del estado y usa hora de Chile.
assert.match(worker, /signal: AbortSignal\.timeout\(25000\)/);
assert.match(worker, /WHERE id = 'main' AND updated_at IS \?/);
assert.match(worker, /toLocaleString\("es-CL", \{ timeZone: "America\/Santiago" \}\)/);
// (6) El token de la planilla NO vive en el código (repositorio público): solo en SHEETS_SCRIPT_TOKEN.
assert.doesNotMatch(worker, /script\.google\.com\/macros\/s\/[^"'`\s]+token=/);
assert.doesNotMatch(worker, /CORTADOS_SYNC_URL_FALLBACK/);
assert.match(worker, /env\?\.SHEETS_SCRIPT_TOKEN/);
// (7) Escrituras a la planilla: solo acciones de la lista cerrada.
assert.match(worker, /!SHEETS_SCRIPT_ACTIONS\.has\(String\(body\.action/);

// Caso real (2026-10-05, 56912000007): cliente sin internet respondió solo su nombre ("Raul Paredes") a la
// pregunta de un agente y el bot le dijo su saldo pendiente. Los datos de cobranza solo se ofrecen a la IA si
// el mensaje actual habla de pagos, y el prompt prohíbe sacar el tema de plata por su cuenta.
{
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(`${functionSource("mentionsBillingTopic")}\nthis.api = { mentionsBillingTopic };`, ctx);
  for (const yes of ["¿cuánto debo?", "ya pagué", "mando el comprobante", "cuando vence mi boleta", "cual es mi saldo", "voy a cancelar hoy"]) {
    assert.equal(ctx.api.mentionsBillingTopic(yes), true, yes);
  }
  for (const no of ["Raul Paredes", "Hola llevo varios dias sin internet", "no tengo señal", "la luz del router está roja", "buenos dias"]) {
    assert.equal(ctx.api.mentionsBillingTopic(no), false, no);
  }
}
assert.match(worker, /const billingTopic = mentionsBillingTopic\(inboundMessage\?\.text\);/);
assert.match(worker, /billingTopic && context\.customer\.paymentStatus/);
assert.match(worker, /billingTopic && context\.customer\.dueDate/);
assert.match(worker, /NUNCA menciones saldo, deuda, monto pendiente, estado de pago ni vencimiento si en el mensaje ACTUAL/);

// Comprobantes (2026-10-05): la IA lee también PDFs; el aviso a Carlos trae una verificación (monto vs deuda
// pendiente y operación repetida). Nada de esto marca pagos: solo informa a quien los registra.
{
  const ctx = { Math, Number, String, Array, JSON, Promise };
  vm.createContext(ctx);
  vm.runInContext(`
    ${functionSource("normalizeWhatsAppPhone")}
    ${functionSource("normalizeReceiptTransactionId")}
    async ${functionSource("buildReceiptCheck")}
    ${functionSource("hasExplicitPaymentIntent")}
    ${functionSource("hasStrongReceiptEvidence")}
    this.api = { normalizeReceiptTransactionId, buildReceiptCheck, hasStrongReceiptEvidence };
  `, ctx);
  assert.equal(ctx.api.normalizeReceiptTransactionId("Op. 12-345 678"), "OP12345678");
  assert.equal(ctx.api.normalizeReceiptTransactionId("123"), null);
  const records = [{ phone: "56911112222", status: "Pendiente", amount: 18000, billingMonth: "octubre" },
    { phone: "56933334444", status: "Pendiente", amount: 18000, billingMonth: "septiembre" },
    { phone: "56933334444", status: "Pendiente", amount: 18000, billingMonth: "octubre" }];
  const makeEnv = (duplicate) => ({ DB: { prepare: (sql) => ({ bind: () => ({
    first: async () => (/billingRecords|app_state/.test(sql) ? { data: JSON.stringify({ billingRecords: records }) } : duplicate),
    run: async () => ({}),
  }), first: async () => ({ data: JSON.stringify({ billingRecords: records }) }) }) } });
  Promise.all([
    ctx.api.buildReceiptCheck(makeEnv(null), "56911112222", { extracted_amount: 18000 }, "c1"),
    ctx.api.buildReceiptCheck(makeEnv(null), "56911112222", { extracted_amount: 25000 }, "c1"),
    ctx.api.buildReceiptCheck(makeEnv(null), "56933334444", { extracted_amount: 36000 }, "c1"),
    ctx.api.buildReceiptCheck(makeEnv(null), "56955556666", { extracted_amount: 18000 }, "c1"),
    ctx.api.buildReceiptCheck(makeEnv(null), "56911112222", {}, "c1"),
    ctx.api.buildReceiptCheck(makeEnv({ id: "c0", phone: "56900000000", created_at: "2026-10-01T10:00:00Z" }), "56911112222", { extracted_amount: 18000, transaction_id: "ABC123456" }, "c1"),
  ]).then(([exact, mismatch, sum, none, noAmount, repeated]) => {
    assert.match(exact, /COINCIDE con octubre pendiente/);
    assert.match(mismatch, /NO coincide/);
    assert.match(sum, /COINCIDE con la suma de 2 meses/);
    assert.match(none, /no hay deuda pendiente/);
    assert.match(noAmount, /No se pudo leer el monto/);
    assert.match(repeated, /POSIBLE REPETIDO/);
  }).catch((error) => { console.error(error); process.exit(1); });
  const strong = { receipt_evidence: ["bank", "amount", "date_time"] };
  assert.equal(ctx.api.hasStrongReceiptEvidence(strong, { mediaType: "document", mediaMime: "application/pdf", mediaId: "m1" }), true);
  assert.equal(ctx.api.hasStrongReceiptEvidence(strong, { mediaType: "document", mediaMime: "application/msword", mediaId: "m1" }), false);
  assert.equal(ctx.api.hasStrongReceiptEvidence(strong, { mediaType: "image", mediaMime: "image/jpeg", mediaId: "m1" }), true);
}
assert.match(worker, /type: "file", file: \{ filename: "comprobante\.pdf", file_data: `data:application\/pdf;base64,\$\{media\.base64\}` \}/);
assert.match(worker, /if \(\(!response \|\| !response\.ok\) && isPdf\) \{\s*\n\s*pdfUnread = true;/);
assert.match(worker, /if \(pdfUnread\) \{ parsed\.receipt_evidence = \[\]/);
assert.match(worker, /transaction_id: \{ type: "string"/);
assert.match(worker, /mediaMime: media\?\.mimeType \|\| null/);
assert.match(worker, /`Comprobante recibido\. \$\{receiptCheck\}`/);

// Muestra real de respuestas del bot (2026-10-06): nota interna filtrada al cliente, promesa de llegada del
// técnico, saludo respondido con la frase robótica prohibida y "Necesito el nombre del titular" repetido ante
// cualquier mensaje.
{
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(`
    ${functionSource("cyberNormalize")}
    ${functionSource("botTextProblem")}
    ${functionSource("isPureGreeting")}
    this.api = { botTextProblem, isPureGreeting };
  `, ctx);
  assert.equal(ctx.api.botTextProblem("El cliente quiere hablar con un ejecutivo y menciona que no recibió respuesta a su consulta de ayer."), "internal_note");
  assert.equal(ctx.api.botTextProblem("Quedó registrada la solicitud. Un técnico llegará a tu domicilio mañana en la mañana. 👍"), "schedule_promise");
  assert.equal(ctx.api.botTextProblem("De nada, Francisco. ¡Nos vemos mañana con el técnico! 🛠️"), "schedule_promise");
  assert.equal(ctx.api.botTextProblem("Un técnico te contactará hoy"), "schedule_promise");
  assert.equal(ctx.api.botTextProblem("Registramos tu solicitud de visita técnica, un agente te confirmará el horario. 🙌"), null);
  assert.equal(ctx.api.botTextProblem("Reinicia el router por 2 minutos y cuéntame cómo sigue."), null);
  for (const yes of ["Buenas tardes", "Hola", "hola buenas", "Buen día", "Buenos días!"]) assert.equal(ctx.api.isPureGreeting(yes), true, yes);
  for (const no of ["Hola, no tengo internet", "Buenas tardes quiero pagar", "Consulta cuanto sale una caja repetidora"]) assert.equal(ctx.api.isPureGreeting(no), false, no);
}
assert.match(worker, /action = action\.action === "reply" \? \{ action: "escalate", reason: `bot_text_blocked_\$\{textProblem\}` \}/);
assert.doesNotMatch(worker, /sendBotReply\(env, credentials, phone, action\.text \|\| "Ya te comunico con un agente/);
assert.match(worker, /NUNCA prometas ni confirmes el día u hora en que llegará un técnico/);
assert.match(worker, /if \(\(asked\?\.n \|\| 0\) < 2\) \{/);
assert.equal((worker.match(/askForAccountNameOrHandOff\(env, credentials, phone, text, message, preferAudio\)/g) || []).length, 4); // definición + 3 usos

// Caso real (2026-10-06, 56912000018): el cliente contestó "El de 25" a los planes de $18.000 y $25.000 (30 y 50 Mb/s);
// no calzaba con ninguna velocidad y la conversación quedó en silencio (además un bot_exception sin explicación).
{
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(`
    const PLAN_GROUPS = {
      otros: { plans: [{ speed: "30mb/s", price: 18000 }, { speed: "50mb/s", price: 25000 }] },
      cayucupil: { plans: [{ speed: "100mb/s", price: 18000 }, { speed: "300mb/s", price: 25000 }, { speed: "500mb/s", price: 30000 }] },
    };
    ${functionSource("matchChosenPlan")}
    this.api = { matchChosenPlan };
  `, ctx);
  assert.equal(ctx.api.matchChosenPlan("otros", "El de 25").price, 25000);
  assert.equal(ctx.api.matchChosenPlan("otros", "el de 18").price, 18000);
  assert.equal(ctx.api.matchChosenPlan("otros", "el de 50").speed, "50mb/s", "una velocidad real gana sobre el precio en miles");
  assert.equal(ctx.api.matchChosenPlan("otros", "el de 30").speed, "30mb/s");
  assert.equal(ctx.api.matchChosenPlan("cayucupil", "el de 25").speed, "300mb/s");
  assert.equal(ctx.api.matchChosenPlan("cayucupil", "el de 30").speed, "500mb/s");
  assert.equal(ctx.api.matchChosenPlan("otros", "300mb"), null);
  assert.equal(ctx.api.matchChosenPlan("otros", "quiero contratar"), null);
}
assert.match(worker, /console\.error\("bot_exception", phone, detail\);/);
assert.match(worker, /"Error del bot"/);

// Comprobantes que no avisaban (2026-10-07): (1) un cliente con bloqueo humano viejo mandó su comprobante y el bot
// contestó "tu comprobante sigue en revisión" sin crear caso ni avisar; (2) quien mandaba el comprobante y no
// contestaba su nombre nunca generaba aviso; (3) la IA escribió "Tu pago ha sido registrado correctamente".
{
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(`
    function inboundMessageText(message) { return message.text?.body || ""; }
    function hasExplicitPaymentIntent(text) { return /pagu|pago|comprobante|transfer/i.test(String(text || "")); }
    ${functionSource("mentionsBillingTopic")}
    function cyberNormalize(value) { return String(value || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase(); }
    ${functionSource("mentionsTechnicalIssueOrVisit")}
    ${functionSource("isCaseStatusQuestion")}
    ${functionSource("reactivationNeedsNormalFlow")}
    this.api = { reactivationNeedsNormalFlow };
  `, ctx);
  // 2026-10-07 (56912000019): un reporte de falla no es una pregunta por el trámite viejo.
  assert.equal(ctx.api.reactivationNeedsNormalFlow({ type: "text", text: { body: "Buenas tardes en Cayucupil hay un cable cortado de ustedes" } }), true);
  assert.equal(ctx.api.reactivationNeedsNormalFlow({ type: "text", text: { body: "sigue sin internet" } }), true);
  assert.equal(ctx.api.reactivationNeedsNormalFlow({ type: "text", text: { body: "quiero cambiar mi plan a uno más rápido" } }), true);
  assert.equal(ctx.api.reactivationNeedsNormalFlow({ type: "text", text: { body: "¿ya revisaron mi comprobante?" } }), true);
  assert.equal(ctx.api.reactivationNeedsNormalFlow({ type: "text", text: { body: "¿y mi solicitud?" } }), false);
  assert.equal(ctx.api.reactivationNeedsNormalFlow({ type: "image" }), true);
  assert.equal(ctx.api.reactivationNeedsNormalFlow({ type: "document" }), true);
  assert.equal(ctx.api.reactivationNeedsNormalFlow({ type: "text", text: { body: "ya pagué, te envío el comprobante" } }), true);
  assert.equal(ctx.api.reactivationNeedsNormalFlow({ type: "text", text: { body: "cuanto debo" } }), true);
  assert.equal(ctx.api.reactivationNeedsNormalFlow({ type: "text", text: { body: "hola, ¿cómo va mi solicitud?" } }), false);
}
assert.match(worker, /const safeReply = reactivationNeedsNormalFlow\(message\) \? null : safeReplyForReactivatedBusinessHandoff\(sessionRow\.escalation_reason\);/);
assert.match(worker, /const recoveredHandoffReply = reactivationNeedsNormalFlow\(message\) \? null : safeReplyForReactivatedBusinessHandoff\(message\.reactivatedHandoffReason\);/);
assert.doesNotMatch(worker, /sendBotReply\(env, credentials, phone, action\.text \|\| "Recibimos tu comprobante/);
assert.match(worker, /"Nombre pendiente", phone,\s*\n\s*`Comprobante recibido \(el cliente aún no indica a nombre de quién\)/);

// Revisión de punta a punta (2026-10-07) con 3.300 escenarios simulados contra el Worker real:
assert.match(worker, /if \(salesLead && !funnelYields && message\.type !== "image" && message\.type !== "document"\) \{/, "un adjunto nunca es respuesta del embudo de venta");
assert.match(worker, /await sendBotReply\(env, credentials, phone, "Registramos tu solicitud de visita técnica, un agente te confirmará el horario\. 🙌", preferAudio\);/);
assert.doesNotMatch(worker, /action\.text \|\| "Registramos tu solicitud de visita/);
assert.match(worker, /final_template|"text_fallback"/);
assert.match(worker, /const textFallbackId = null|let textFallbackId = null;/);
assert.match(worker, /const flushed = await flushQueuedStaffNotifications\(env\)/);

// Estado pendiente que caduca (2026-10-07): 16 "esperando nombre" desde el 20-sep y 11 leads abiertos desde el 18-sep
// secuestraban los mensajes futuros de esos clientes.
assert.match(worker, /const PENDING_NAME_TTL_HOURS = 6;/);
assert.match(worker, /const SALES_LEAD_TTL_DAYS = 3;/);
assert.match(worker, /await expireStaleConversationState\(env, phone\)\.catch\(\(\) => null\);\s*\n\s*const salesLead = await env\.DB\.prepare\(/);
assert.match(worker, /const expired = await expireStaleConversationState\(env\)/);

// Límite de intentos de inicio de sesión (la contraseña se compara en texto plano contra la planilla).
assert.match(worker, /\(failed\?\.n \|\| 0\) >= 10\) return Response\.json\(\{ ok: false, error: "Demasiados intentos\. Espera 15 minutos\." \}, \{ status: 429 \}\)/);

// Embudo que secuestraba mensajes (2026-10-07, 56912000003 y revisión por estados): sector = cualquier texto,
// "quiero hablar con alguien" ignorado, saludo guardado como nombre, preguntas contestadas con "Anotado ✅".
{
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(`
    ${functionSource("cyberNormalize")}
    ${functionSource("isPureGreeting")}
    ${functionSource("isClosingPleasantry")}
    ${functionSource("isHumanRequest")}
    ${functionSource("isPlausibleSector")}
    this.api = { isHumanRequest, isPlausibleSector };
  `, ctx);
  for (const yes of ["quiero hablar con alguien", "necesito un ejecutivo", "Quiero hablar con una persona por favor", "comunicarme con un agente", "atención humana"]) assert.equal(ctx.api.isHumanRequest(yes), true, yes);
  for (const no of ["el agente me dijo que pagara", "no tengo internet", "hola", "es una persona mayor"]) assert.equal(ctx.api.isHumanRequest(no), false, no);
  for (const yes of ["Lanalhue", "Peleco", "sector Cayucupil", "Los Aromos, Cañete", "Trangilboro", "Cañete"]) assert.equal(ctx.api.isPlausibleSector(yes), true, yes);
  for (const no of ["Hola muy buenas tardes", "ok gracias", "¿se podría?", "Necesito ayuda con la forma de pago", "quiero contratar internet", "webpaycl comprobante Pago 1b6fu", "hola", "buenas tardes, quisiera saber si llega internet a mi casa por favor"]) assert.equal(ctx.api.isPlausibleSector(no), false, no);
}
assert.match(worker, /if \(!isPlausibleSector\(text\)\) \{/);
assert.match(worker, /if \(!isStaffPhone && String\(text \|\| ""\)\.trim\(\) && isHumanRequest\(text\) && !isOptOutMessage\(text\)\) \{/);
assert.match(worker, /fragment \? `Anotado ✅ \$\{describeInstallationFragment\(fragment\)\}\. Todavía me falta/);
// 2026-10-20 (56912000014): datos de instalación dados de a poco, con errores y repeticiones.
{
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(`
    ${functionSource("cyberNormalize")}
    ${functionSource("isPureGreeting")}
    ${functionSource("isLikelyNotAName")}
    ${functionSource("isNameLikeFragment")}
    ${installationParserDeps()}
    ${functionSource("classifyInstallationFragment")}
    this.api = { classifyInstallationFragment };
  `, ctx);
  const c = (text, cur = { name: null, address: null }) => ctx.api.classifyInstallationFragment(text, cur);
  // 2026-10-20: el RUT se guarda normalizado; "81234566" tiene verificador válido (8.123.456-6).
  assert.deepEqual(JSON.parse(JSON.stringify(c("81234566"))), { rut: "8123456-6" });
  assert.deepEqual(JSON.parse(JSON.stringify(c("Marta de Lourdes Soto Rivas."))), { name: "Marta de Lourdes Soto Rivas" });
  assert.deepEqual(JSON.parse(JSON.stringify(c("Nombre de titular:Marta de Lourdes Soto Rivas"))), { name: "Marta de Lourdes Soto Rivas" });
  assert.deepEqual(JSON.parse(JSON.stringify(c("8.123.456-6"))), { rut: "8123456-6" });
  assert.deepEqual(JSON.parse(JSON.stringify(c("912000023"))), { phone: "912000023" });
  assert.equal(c("cliente1@ejemplo.cl").email, "cliente1@ejemplo.cl");
  // un número suelto ya no se vuelve dirección, y el nombre posterior no se pega a ella
  const afterRut = c("Marta Soto Rivas", { name: null, address: null });
  assert.deepEqual(JSON.parse(JSON.stringify(afterRut)), { name: "Marta Soto Rivas" });
  // reenvío de su nombre: el último reemplaza al anterior (no se concatenan)
  assert.deepEqual(JSON.parse(JSON.stringify(c("Marta Soto Rivas", { name: "Marta de Lourdes Soto Rivas", address: null }))), { name: "Marta Soto Rivas" });
  // nombre dentro de una frase
  assert.deepEqual(JSON.parse(JSON.stringify(c("Que honda si ya le di el nombre de la titular que quiere instalar el waifai aca en peleco que es Marta Soto Rivas"))), { name: "Marta Soto Rivas" });
  // una pregunta o frase suelta no es nombre
  assert.equal(c("Se lo envie dos veces ya"), null);
  assert.equal(c("Yo necesito solo internet"), null);
}
assert.match(worker, /if \(\(askedBefore\?\.n \|\| 0\) >= 7\) \{/);
assert.match(worker, /if \(!fragment && looksLikeQuestion\(text\)\) \{/);
assert.match(worker, /"Cliente esperando factibilidad"/);
assert.match(worker, /const SALES_LEAD_FACTIBILIDAD_TTL_DAYS = 7;/);

// 2026-10-08 (56912000004): "muy lento" -> "en todos" -> visita al tiro. El bot debe indagar por código antes de
// registrar una visita por falla, salvo que el cliente la pida explícitamente.
assert.match(worker, /async function pendingDiagnosticQuestion\(env, phone, customerText, knownAddress\)/);
assert.match(worker, /que el cliente confirme|NO uses "visit_request" mientras falte reinicio del router/);
assert.doesNotMatch(worker, /Sigue así hasta que el cliente confirme que afecta a todos los dispositivos/);

// 2026-10-08 (56912000029, adulto mayor): "datos De cuenta ... para hacer pago" y "trasferir" (sin n) deben dar los
// datos de transferencia; el bot nunca debe afirmar que no se puede transferir.
{
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(`${functionSource("isAlternativePaymentRequest")}; this.api = { isAlternativePaymentRequest };`, ctx);
  assert.equal(ctx.api.isAlternativePaymentRequest("Podrían enviar los datos De cuenta y nombre para hacer pago se me borraron"), true);
  assert.equal(ctx.api.isAlternativePaymentRequest("Hola no puedo pagar podría trasferir a la cuenta"), true);
  assert.equal(ctx.api.isAlternativePaymentRequest("no puedo pagar por la pagina"), true);
  assert.equal(ctx.api.isAlternativePaymentRequest("hola buenas tardes"), false);
}
assert.match(worker, /NUNCA digas que "no se puede realizar transferencia"/);

// 2026-10-08: modelo por defecto subido de gpt-4o-mini (2024) a gpt-4.1-mini (mismos parámetros, costo bajo).
assert.match(worker, /model: String\(env\.OPENAI_MODEL \|\| "gpt-4\.1-mini"\)/);

// 2026-10-08 (56912000011): foto de comprobante CajaVecina sin texto fue contestada con "BPGO solo ofrece internet,
// no televisión". Un adjunto sin texto nunca recibe una respuesta de conversación, y BPGO sí ofrece TV cable.
assert.match(worker, /const attachmentOnly = \(message\.inboundType === "image" \|\| message\.inboundType === "document"\) && !String\(message\.customerText \|\| ""\)\.trim\(\);\s*\n\s*if \(attachmentOnly && action\.action === "reply"\)/);
assert.match(worker, /inboundType: message\.type \|\| null,/);
assert.match(worker, /const attachmentOnlyNote = /);
// 2026-10-17: las FAQ reales dicen que BPGO provee SOLO internet (la regla anterior de "internet Y TV cable" era un error mío).
assert.match(worker, /BPGO provee ÚNICAMENTE internet por fibra óptica; NO vende TV./);
assert.doesNotMatch(worker, /BPGO ofrece internet Y TV cable/);
// 2026-10-17 (56912000006): preguntas sobre qué incluyen los planes se responden con texto fijo y no se guardan como nombre.
assert.match(worker, /const SALES_PLAN_INFO_REPLY = "Todos nuestros planes son de internet por fibra óptica, sin límite de datos. No incluyen TV/);
assert.match(worker, /if \(salesLead\.status === "awaiting_plan" && String\(text \|\| ""\)\.trim\(\)\) \{\s*\n\s*if \(isSalesPlanInfoQuestion\(text\)\)/);
// 2026-10-20: el texto que no parece nombre ya no se descarta siempre: si viene después del nombre y aún no hay
// dirección, es la dirección ("Valle Verde , Cayucupil"). Las preguntas siguen sin guardarse (installation-capture.test.js).
assert.match(worker, /if \(isInstallationAddress\(rest\)\) \{/);

// 2026-10-09: D1 free tier "daily row read limit" excedido. El esquema se verifica una vez por instancia y las
// consultas de listados/avisos usan índices (antes escaneaban tablas completas en cada mensaje y cada sondeo del panel).
assert.match(worker, /const SCHEMA_READY = new Set\(\);/);
assert.match(worker, /async function ensureWhatsAppInboxTable\(env\) \{\s*\n\s*if \(SCHEMA_READY\.has\("ensureWhatsAppInboxTable"\)\) return;/);
assert.match(worker, /idx_whatsapp_inbox_created ON whatsapp_inbox_messages\(created_at\)/);
assert.match(worker, /idx_staff_notifications_role_status ON staff_notifications_log\(role, status, created_at\)/);

// 2026-10-09 (respuestas al recordatorio de cobranza): promesas futuras no son pago hecho, "el link" sin "de pago" se
// responde con el portal, un saludo no recibe "sigue en revisión" y un texto sin adjunto no es un comprobante.
{
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(`
    function cyberNormalize(value) { return String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase(); }
    ${functionSource("isPaidQuickReply")}
    ${functionSource("isPaymentLinkRequest")}
    ${functionSource("isCaseStatusQuestion")}
    this.api = { isPaidQuickReply, isPaymentLinkRequest, isCaseStatusQuestion };
  `, ctx);
  assert.equal(ctx.api.isPaidQuickReply("Apenas pague le envío el boucher"), false);
  assert.equal(ctx.api.isPaidQuickReply("mañana le deposito y le mando el baucher"), false);
  assert.equal(ctx.api.isPaidQuickReply("Pero si pague el 26 de septiembre"), true);
  assert.equal(ctx.api.isPaidQuickReply("ya pagué"), true);
  assert.equal(ctx.api.isPaymentLinkRequest("Y cuál es el link me lo puede enviar por favor"), true);
  assert.equal(ctx.api.isCaseStatusQuestion("Hola"), false);
  assert.equal(ctx.api.isCaseStatusQuestion("¿y mi solicitud?"), true);
}
assert.match(worker, /if \(!message\.mediaId\) \{\s*\n\s*await sendBotReply\(env, credentials, phone, "Gracias por avisar 🙏 Cuando tengas el comprobante/);
assert.match(worker, /La campaña\/promoción Cyber ya TERMINÓ/);
assert.match(worker, /El monto a pagar es \$\{formatCurrency\(c\.balance\)\}/);

// 2026-10-10: la incidencia técnica llega con dirección, reporte, luces, reinicio, dispositivos y horario; el bot
// pregunta dirección (si no está registrada) y horario antes de registrar la visita.
assert.match(worker, /async function buildIncidentSummary\(env, phone, aiReason, address\)/);
assert.match(worker, /await buildIncidentSummary\(env, phone, action\.reason, customer\.address\)/);
assert.match(worker, /await buildIncidentSummary\(env, phone, pendingVisit\.reason, customer\.address\)/);
assert.match(worker, /pendingDiagnosticQuestion\(env, phone, message\.customerText, matchedCustomer\.address\)/);
assert.match(worker, /sanitizeStaffTemplateParam\(summary, 700\)/);

// 2026-10-10: horario del bot (opción 1 de Carlos): fuera de horario el bot avisa una vez y al reabrir retoma el último
// mensaje pendiente; adjuntos y personal pasan a cualquier hora. Configurable con BOT_HOURS / BOT_DAYS.
{
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(`
    ${worker.slice(worker.indexOf("const BOT_HOURS_DEFAULT"), worker.indexOf("function offHoursNoticeText"))}
    this.api = { isBotOpenNow, botScheduleConfig };
  `, ctx);
  const env = { BOT_HOURS: "09:00-21:00", BOT_DAYS: "1-7" };
  // 2026-10-12 (lunes) 12:00 hora de Chile (UTC-3 en octubre) = 15:00Z; 23:30 Chile = 02:30Z del día siguiente.
  assert.equal(ctx.api.isBotOpenNow(env, new Date("2026-10-12T15:00:00Z")), true);
  assert.equal(ctx.api.isBotOpenNow(env, new Date("2026-10-13T02:30:00Z")), false);
  assert.equal(ctx.api.isBotOpenNow(env, new Date("2026-10-12T11:00:00Z")), false);
  assert.equal(ctx.api.isBotOpenNow({ BOT_HOURS: "09:00-21:00", BOT_DAYS: "1-5" }, new Date("2026-10-10T15:00:00Z")), false); // sábado
  assert.equal(ctx.api.isBotOpenNow({ BOT_HOURS: "09:00-21:00", BOT_DAYS: "1-5" }, new Date("2026-10-12T15:00:00Z")), true);
  assert.equal(ctx.api.isBotOpenNow({}, new Date("2026-10-12T15:00:00Z")), true);
}
assert.match(worker, /if \(!isBotOpenNow\(env\) && message\.type !== "image" && message\.type !== "document"\)/);
assert.match(worker, /if \(!isBotOpenNow\(env\)\) return \{ ok: true, taken: 0, reason: "closed" \};/);
assert.match(worker, /takeOverUnansweredHumanChats\(env\)\.then\(\(\) => resumeAfterHoursChats\(env\)\)/);

// 2026-10-10: horario definido por Carlos: 09:00 a 19:30 y mensaje fijo fuera de horario.
assert.match(worker, /const BOT_HOURS_DEFAULT = "09:00-19:30";/);
assert.match(worker, /return "Gracias por tu mensaje\. Estamos fuera de horario laboral\. ⏰ Te responderemos tan pronto como volvamos\. 😊";/);
{
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(`${worker.slice(worker.indexOf("const BOT_HOURS_DEFAULT"), worker.indexOf("function offHoursNoticeText"))} this.api = { isBotOpenNow };`, ctx);
  assert.equal(ctx.api.isBotOpenNow({}, new Date("2026-10-12T22:15:00Z")), true);  // 19:15 Chile
  assert.equal(ctx.api.isBotOpenNow({}, new Date("2026-10-12T22:45:00Z")), false); // 19:45 Chile
  assert.equal(ctx.api.isBotOpenNow({}, new Date("2026-10-12T12:00:00Z")), true);  // 09:00 Chile
}

// 2026-10-13 (56912000021): si el mensaje que dispara new_customer_request ya trae el sector, no se vuelve a preguntar.
assert.match(worker, /const sectorGuess = extractSectorFromText\(message\.customerText\) \|\| await findSectorHint\(env, phone\);/);
assert.match(worker, /VALUES \(\?, \?, \?, \?, 'awaiting_location', datetime\('now'\), datetime\('now'\)\)/);

// 2026-10-13 (56912000016): una solicitud del embudo anterior a una intervención humana manual se cancela al volver el bot.
assert.match(worker, /async function expireLeadsSupersededByHuman\(env, phone, sessionUpdatedAt, reason, message\)/);
assert.match(worker, /await expireLeadsSupersededByHuman\(env, phone, sessionRow\.updated_at, sessionRow\.escalation_reason, message\)/);
assert.match(worker, /await expireLeadsSupersededByHuman\(env, row\.phone, row\.session_updated_at, row\.escalation_reason, null\)/);

// 2026-10-13 (56912000015): un cliente registrado que quiere contratar sigue el embudo, no se escala en seco.
assert.doesNotMatch(worker, /Cliente ya registrado consulta por contratación\/visita/);

// Las planillas de Google (con RUT, direcciones y teléfonos) exigen sesión antes del proxy a STABLE_BACKEND.
{
  const guard = worker.indexOf('if (url.pathname === "/api/billing/sheets-sync" || url.pathname.startsWith("/api/business/")');
  for (const route of ['"/api/backups"', '"/api/evidence"', '"/api/evidence-file"']) {
    assert.ok(worker.slice(guard, guard + 600).includes(route), "ruta sin sesión: " + route);
  }
  const proxy = worker.indexOf('if (url.pathname.startsWith("/api/")) {');
  assert.ok(guard > 0 && guard < proxy, "sheets-sync y sheets-workbook deben validar sesión antes del proxy genérico");
}

// 2026-10-17: el medio preferido es el portal con tarjeta (Webpay). Ante "datos para transferir" se ofrece primero el portal; los
// datos bancarios solo si el cliente insiste, no puede usar tarjeta/link o menciona CajaVecina/efectivo.
{
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(`${functionSource("needsBankDataDirectly")}; this.api = { needsBankDataDirectly };`, ctx);
  assert.equal(ctx.api.needsBankDataDirectly("no puedo pagar con tarjeta, me das la cuenta"), true);
  assert.equal(ctx.api.needsBankDataDirectly("el link no me funciona"), true);
  assert.equal(ctx.api.needsBankDataDirectly("voy a pagar en caja vecina"), true);
  assert.equal(ctx.api.needsBankDataDirectly("no tengo tarjeta"), true);
  assert.equal(ctx.api.needsBankDataDirectly("Holaa cuál es el valor para transferir"), false);
  assert.equal(ctx.api.needsBankDataDirectly("Podrían enviar los datos De cuenta y nombre para hacer pago"), true);
  assert.equal(ctx.api.needsBankDataDirectly("cual es la cuenta"), true);
  assert.equal(ctx.api.needsBankDataDirectly("quiero transferir"), false);
  assert.equal(ctx.api.needsBankDataDirectly("quiero pagar mi mensualidad"), false);
}
assert.match(worker, /const WEBPAY_FIRST_MARKER = "Puedes pagar en un minuto con tarjeta";/);
assert.doesNotMatch(worker, /avísame y te paso los datos de transferencia/);
assert.match(worker, /if \(alreadyOffered \|\| needsBankDataDirectly\(inboundMessage\?\.text\)\) return \{ action: "reply", text: amountLine \+ PAYMENT_TRANSFER_REPLY \};/);
assert.match(worker, /return \{ action: "reply", text: amountLine \+ WEBPAY_FIRST_REPLY \};/);
assert.match(worker, /El medio de pago PREFERIDO es el portal con tarjeta de débito o crédito/);
assert.match(worker, /const MANUAL_REMINDER_V2 = \{\s*\n\s*name: "recordatorio_pago_bpgo_v2"/);
assert.match(worker, /if \(v2 === "APPROVED"\) templateName = MANUAL_REMINDER_V2\.name;/);
assert.match(worker, /https:\/\/bpgo\.cl\/pagar\. Si ya realizaste el pago, puedes omitir este mensaje\./);

// 2026-10-19: Huechicura usa el tarifario de Cayucupil (Carlos lo indicó en una solicitud anterior).
assert.match(worker, /"fundo anique", "rucanire", "huechicura", "canete"/);

// 2026-10-19: el mensaje que arma bpgo.cl tras un pago por Webpay se confirma como ingresado SOLO si la planilla lo muestra PAGADO;
// si no, se avisa que se verifica (y a Carlos). Nunca se pide comprobante.
{
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(`${functionSource("parseWebpayPaymentNotice")}; this.api = { parseWebpayPaymentNotice };`, ctx);
  const ok = ctx.api.parseWebpayPaymentNotice("Hola BPGO, pagué mi mensualidad por Webpay. Orden: BPGO261019180624FB9EXU. Monto: $18.000. Autorización: 823962.");
  assert.equal(ok.order, "BPGO261019180624FB9EXU");
  assert.equal(ok.amount, "18.000");
  assert.equal(ok.authorization, "823962");
  assert.equal(ctx.api.parseWebpayPaymentNotice("pagué por webpay"), null);
  assert.equal(ctx.api.parseWebpayPaymentNotice("Orden: BPGO123456789 pagué"), null);
}
assert.match(worker, /const registered = await webpayPaymentIsRegistered\(env, phone\)\.catch\(\(\) => false\);/);
assert.match(worker, /return hits\.length === 1 && hits\[0\]\.reason === "paid";/);
assert.match(worker, /ya quedó ingresado ✅/);

// 2026-10-20: la cobranza automática dependía solo del cron de GitHub (retrasos de 3-6 h). Respaldo desde los webhooks, con reclamo atómico por cliente.
assert.match(worker, /async function runBillingAutomationIfDue\(env\)/);
assert.match(worker, /clock\.minutes < 10 \* 60 \+ 15 \|\| clock\.minutes >= 19 \* 60 \+ 30/);
assert.match(worker, /WHERE \(billing_automation_sends\.status='failed' AND COALESCE\(billing_automation_sends\.error_code,''\) != '131026'\) OR \(billing_automation_sends\.status='pending' AND billing_automation_sends\.updated_at < datetime\('now','-10 minutes'\)\)/);
assert.match(worker, /previous\.status === "failed" && String\(previous\.error_code \|\| ""\) === "131026"/);
assert.match(worker, /if \(claim\?\.meta && Number\(claim\.meta\.changes\) === 0\) continue;/);
assert.match(worker, /let billingRevalidationCache = \{ at: 0, month: null, parsed: null \};/);

// 2026-10-20: la lectura de la planilla de cobranza reintenta (3 intentos, 20 s c/u) y reporta la causa real; el día 20 se abortó el lote por
// una lectura que se colgó.
(async () => {
  const make = (behaviors) => {
    const ctx = { AbortSignal, JSON, String, Promise, Array, Error, STABLE_BACKEND: "backend.example", calls: 0 };
    ctx.setTimeout = (fn) => { fn(); return 0; };
    ctx.sheetsScriptUrl = () => null;
    ctx.fetch = async () => { const b = behaviors[ctx.calls] || behaviors[behaviors.length - 1]; ctx.calls += 1; return b(); };
    vm.createContext(ctx);
    vm.runInContext(`
      const SHEET_READ_ATTEMPTS = 3;
      const SHEET_READ_TIMEOUT_MS = 20000;
      async ${functionSource("fetchFreshBillingSource")}
      this.api = { fetchFreshBillingSource };
    `, ctx);
    return ctx;
  };
  const okResponse = () => ({ ok: true, status: 200, json: async () => ({ ok: true, rows: [["a"]] }) });
  const badResponse = () => ({ ok: false, status: 502, json: async () => ({ ok: false, error: "Apps Script no disponible" }) });
  const hang = () => { const error = new Error("timeout"); error.name = "TimeoutError"; throw error; };
  const flaky = make([hang, badResponse, okResponse]);
  assert.deepEqual((await flaky.api.fetchFreshBillingSource({})).rows, [["a"]]);
  assert.equal(flaky.calls, 3);
  const dead = make([hang]);
  await assert.rejects(() => dead.api.fetchFreshBillingSource({}), /No se pudo leer Google Sheets; lote abortado sin envíos\. Causa: sin respuesta en 20 s \(tras 3 intentos\)\./);
  assert.equal(dead.calls, 3);
  const bad = make([badResponse]);
  await assert.rejects(() => bad.api.fetchFreshBillingSource({}), /Causa: HTTP 502 \(Apps Script no disponible\)/);
})().catch((error) => { console.error(error); process.exit(1); });

// 2026-10-21: un enlace de Google Maps cuenta como ubicación; el sector se toma de los mensajes del cliente; nunca se delata que es automático.
{
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(`
    ${functionSource("cyberNormalize")}
    ${functionSource("isPureGreeting")}
    ${functionSource("isClosingPleasantry")}
    ${functionSource("isHumanRequest")}
    ${functionSource("isPlausibleSector")}
    ${worker.slice(worker.indexOf("const MAPS_LINK_PATTERN"), worker.indexOf("function coordinatesFromMapsUrl"))}
    ${functionSource("coordinatesFromMapsUrl")}
    ${functionSource("extractSectorFromText")}
    ${functionSource("sanitizeBotDisclosure")}
    ${functionSource("botTextProblem")}
    this.api = { extractMapsLink, coordinatesFromMapsUrl, extractSectorFromText, sanitizeBotDisclosure, botTextProblem };
  `, ctx);
  const api2 = ctx.api;
  assert.equal(api2.extractMapsLink("https://maps.app.goo.gl/AbCdEf123"), "https://maps.app.goo.gl/AbCdEf123");
  assert.equal(api2.extractMapsLink("mira: https://goo.gl/maps/Q1w2E3r4?g_st=aw."), "https://goo.gl/maps/Q1w2E3r4?g_st=aw");
  assert.equal(api2.extractMapsLink("https://www.google.com/maps/place/Algo/@-37.80,-73.22,17z"), "https://www.google.com/maps/place/Algo/@-37.80,-73.22,17z");
  assert.equal(api2.extractMapsLink("https://bpgo.cl/pagar"), null);
  assert.equal(api2.extractMapsLink("hola buenas"), null);
  assert.deepEqual(JSON.parse(JSON.stringify(api2.coordinatesFromMapsUrl("https://www.google.com/maps/place/Algo/@-37.8013,-73.2263,17z"))), { latitude: -37.8013, longitude: -73.2263 });
  assert.deepEqual(JSON.parse(JSON.stringify(api2.coordinatesFromMapsUrl("https://www.google.com/maps?q=-37.8013,-73.2263"))), { latitude: -37.8013, longitude: -73.2263 });
  assert.equal(api2.coordinatesFromMapsUrl("https://maps.app.goo.gl/AbCdEf123"), null);
  assert.equal(api2.extractSectorFromText("Quería consultar sobre la cobertura en sector Valle Alto  en Cañete"), "Valle Alto");
  assert.equal(api2.extractSectorFromText("Valle Alto , desde el hospital hacia dentro entre el paradero 3 y el 4"), "Valle Alto");
  assert.equal(api2.extractSectorFromText("Lomas Verdes Cañete"), "Lomas Verdes Cañete");
  assert.equal(api2.extractSectorFromText("Hola buen día"), null);
  assert.equal(api2.extractSectorFromText("https://maps.app.goo.gl/AbCdEf123"), null);
  assert.equal(api2.sanitizeBotDisclosure("Este sector no está en las zonas con cobertura confirmada automáticamente, pero puedo consultar con el equipo."), "Este sector no está en las zonas con cobertura confirmada, pero puedo consultar con el equipo.");
  assert.equal(api2.sanitizeBotDisclosure("Tu pago se registra de forma automática."), "Tu pago se registra.");
  assert.equal(api2.botTextProblem("Soy un robot de BPGO"), "reveals_bot");
  assert.equal(api2.botTextProblem("Soy el asistente virtual de BPGO"), "reveals_bot");
  assert.equal(api2.botTextProblem("Tu comprobante está en revisión."), null);
}
assert.match(worker, /\} else if \(extractMapsLink\(text\)\) \{/);
assert.match(worker, /await submitLocationForFactibilidad\(env, credentials, salesLead, phone, name, message, \{ latitude, longitude \}, preferAudio\);/);
assert.match(worker, /NUNCA reveles ni insinúes que la respuesta es automática/);
assert.match(worker, /action = \{ \.\.\.action, text: sanitizeBotDisclosure\(action\.text\) \};/);

// 2026-10-21: el bot debe entender el historial: una ficha de datos enviada tras pedirla (a mano o por el bot) se entrega al equipo y no reinicia el embudo;
// una ficha con RUT/correo/teléfono nunca es un "sector"; el modelo ve 16 mensajes y se le indica continuar lo que un agente ya venía haciendo.
{
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(`
    ${functionSource("cyberNormalize")}
    ${functionSource("isPureGreeting")}
    ${functionSource("isClosingPleasantry")}
    ${functionSource("isHumanRequest")}
    ${functionSource("isPlausibleSector")}
    ${functionSource("extractSectorFromText")}
    this.api = { extractSectorFromText };
  `, ctx);
  const ficha = "Datos\nAna Torres Rojas \n12.345.678-5 \n+56912000060\nana.torres@mail.cl \nSector Valle Verde km 1,7 camino a Cayucupil\nPlan Platino";
  assert.equal(ctx.api.extractSectorFromText(ficha), null);
  assert.equal(ctx.api.extractSectorFromText("Datos Ana Torres Rojas 12.345.678-5"), null);
  assert.equal(ctx.api.extractSectorFromText("Hola, uds instalan fibra óptica en Cañete, sector Valle Verde?"), "Valle Verde");
}
assert.match(worker, /\.bind\(phone, "%datos para realizar la instalaci%"\)\.first\(\);/);
assert.match(worker, /dataPackage\.rut && \(dataPackage\.email \|\| dataPackage\.phone\) && dataPackage\.name && dataPackage\.address/);
assert.match(worker, /history = history\.slice\(-16\);/);
assert.match(worker, /LEE TODO el historial antes de responder/);

// 2026-10-22: una corrida con todos los envíos fallidos no cierra la cobranza del día; el respaldo sigue reintentando.
assert.match(worker, /status = 'completed' AND \(failed_count = 0 OR sent_count > 0\) LIMIT 1/);

// 2026-10-22: si Meta entrega la autorización pero no el evento FINISH (ni el paso del QR), el panel completa con la resolución automática del servidor.
assert.match(fs.readFileSync(path.join(__dirname, "..", "assets", "whatsapp-onboarding-v43.js"), "utf8"), /if \(signupResult\.code && !signupResult\.completed && !signupResult\.exchangeStarted\) finishSignup\(panel, true\);\s*\n\s*\}, 15000\);/);

// 2026-10-22: si el id de teléfono guardado ya no está CONECTADO pero la cuenta tiene el teléfono oficial CONECTADO con otro id, se actualiza solo.
(async () => {
  const run = async (data, credentials) => {
    const updates = [];
    const ctx = { AbortSignal, String, Array, Promise, JSON, updates };
    ctx.fetch = async () => ({ ok: true, json: async () => ({ data }) });
    ctx.env = { DB: { prepare: (sql) => ({ bind: (value) => ({ run: async () => { updates.push(value); } }) }) } };
    vm.createContext(ctx);
    vm.runInContext(`const OFFICIAL_WHATSAPP_DIGITS = "56941985967"; async ${functionSource("reconcileWhatsAppPhoneNumber")}; this.api = { reconcileWhatsAppPhoneNumber };`, ctx);
    const result = await ctx.api.reconcileWhatsAppPhoneNumber(ctx.env, credentials);
    return { result, updates };
  };
  const base = { accessToken: "tok", wabaId: "111", source: "embedded-signup" };
  const stale = await run([{ id: "900", display_phone_number: "+56 9 4198 5967", status: "DISCONNECTED" }, { id: "901", display_phone_number: "+56 9 4198 5967", status: "CONNECTED" }], { ...base, phoneNumberId: "900" });
  assert.equal(stale.result.changed, true);
  assert.deepEqual(stale.updates, ["901"]);
  const fine = await run([{ id: "900", display_phone_number: "+56 9 4198 5967", status: "CONNECTED" }], { ...base, phoneNumberId: "900" });
  assert.equal(fine.result.changed, false);
  assert.deepEqual(fine.updates, []);
  const none = await run([{ id: "900", display_phone_number: "+56 9 4198 5967", status: "DISCONNECTED" }], { ...base, phoneNumberId: "900" });
  assert.equal(none.result.changed, false);
  const otherNumber = await run([{ id: "950", display_phone_number: "+56 9 1111 2222", status: "CONNECTED" }], { ...base, phoneNumberId: "900" });
  assert.equal(otherNumber.result.changed, false);
})().catch((error) => { console.error(error); process.exit(1); });
assert.match(worker, /const expected = officialMatches\.find\(\(candidate\) => candidate\.status === "CONNECTED"\) \|\| officialMatches\[0\];/);
assert.match(worker, /await reconcileWhatsAppPhoneNumber\(env, await getWhatsAppCredentials\(env\)\);\s*\n\s*const result = await runBillingAutomation\(env\);/);

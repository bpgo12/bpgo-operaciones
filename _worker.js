const STABLE_BACKEND = "478e127a.bpgo-operaciones.pages.dev";
const encoder = new TextEncoder();
const MASKED_PASSWORD = "********";

async function ensureWhatsAppOnboardingTable(env) {
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS whatsapp_onboarding_config (
    id TEXT PRIMARY KEY,
    waba_id TEXT,
    phone_number_id TEXT,
    access_token_encrypted TEXT,
    connected_at TEXT,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`).run();
}

async function credentialKey(secret) {
  return crypto.subtle.importKey(
    "raw",
    await crypto.subtle.digest("SHA-256", encoder.encode(String(secret || ""))),
    { name: "AES-GCM" },
    false,
    ["encrypt", "decrypt"],
  );
}

async function encryptCredential(value, secret) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await credentialKey(secret), encoder.encode(value));
  return `${toBase64Url(iv)}.${toBase64Url(encrypted)}`;
}

function fromBase64Url(value) {
  const normalized = String(value || "").replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - normalized.length % 4) % 4);
  return Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
}

async function decryptCredential(value, secret) {
  const [ivPart, encryptedPart] = String(value || "").split(".");
  if (!ivPart || !encryptedPart) return "";
  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: fromBase64Url(ivPart) },
    await credentialKey(secret),
    fromBase64Url(encryptedPart),
  );
  return new TextDecoder().decode(decrypted);
}

async function getWhatsAppCredentials(env) {
  let stored = null;
  if (env.DB) {
    await ensureWhatsAppOnboardingTable(env).catch(() => null);
    stored = await env.DB.prepare("SELECT waba_id, phone_number_id, access_token_encrypted, connected_at FROM whatsapp_onboarding_config WHERE id = 'primary'").first().catch(() => null);
  }
  let storedToken = "";
  if (stored?.access_token_encrypted && env.OPERATIONS_ADMIN_SECRET) {
    storedToken = await decryptCredential(stored.access_token_encrypted, env.OPERATIONS_ADMIN_SECRET).catch(() => "");
  }
  return {
    accessToken: storedToken || String(env.WHATSAPP_ACCESS_TOKEN || "").trim(),
    phoneNumberId: String(stored?.phone_number_id || env.WHATSAPP_PHONE_NUMBER_ID || "").trim(),
    wabaId: String(stored?.waba_id || env.WHATSAPP_WABA_ID || "").trim(),
    connectedAt: stored?.connected_at || null,
    source: storedToken ? "embedded-signup" : "cloudflare-secrets",
  };
}

function normalizeWhatsAppPhone(value) {
  let phone = String(value || "").replace(/\D/g, "");
  if (phone.startsWith("0")) phone = phone.slice(1);
  if (phone.length === 9) phone = `56${phone}`;
  return phone;
}

async function getMetaPhoneConnection(credentials) {
  if (!credentials.accessToken || !credentials.phoneNumberId) {
    return { ok: false, connected: false, status: "UNCONFIGURED", error: "Configuracion incompleta" };
  }
  const useAccountEdge = /^\d+$/.test(String(credentials.wabaId || ""));
  const endpoint = useAccountEdge
    ? `https://graph.facebook.com/v25.0/${encodeURIComponent(credentials.wabaId)}/phone_numbers?fields=id,verified_name,display_phone_number,quality_rating,status&limit=100`
    : `https://graph.facebook.com/v25.0/${encodeURIComponent(credentials.phoneNumberId)}?fields=verified_name,display_phone_number,quality_rating,status`;
  const response = await fetch(endpoint, {
    headers: { authorization: `Bearer ${credentials.accessToken}` },
  });
  const responsePayload = await response.json().catch(() => ({}));
  if (!response.ok) {
    return { ok: false, connected: false, status: "ERROR", error: responsePayload.error?.message || "Meta rechazo la conexion", errorCode: responsePayload.error?.code };
  }
  const payload = useAccountEdge
    ? (Array.isArray(responsePayload.data) ? responsePayload.data.find((item) => String(item.id) === String(credentials.phoneNumberId)) : null)
    : responsePayload;
  if (!payload) return { ok: false, connected: false, status: "NOT_FOUND", error: "El número no pertenece a la cuenta de WhatsApp autorizada." };
  const status = String(payload.status || "UNKNOWN").toUpperCase();
  return {
    ok: true,
    connected: status === "CONNECTED",
    status,
    verifiedName: payload.verified_name,
    displayPhoneNumber: payload.display_phone_number,
    qualityRating: payload.quality_rating,
  };
}

function equalBytes(left, right) {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left[index] ^ right[index];
  return difference === 0;
}

async function ensureWhatsAppStatusTable(env) {
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS whatsapp_message_status (
    message_id TEXT PRIMARY KEY,
    recipient TEXT,
    status TEXT NOT NULL,
    error_json TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`).run();
}

async function saveWhatsAppStatus(env, item) {
  await ensureWhatsAppStatusTable(env);
  await env.DB.prepare(`INSERT INTO whatsapp_message_status
    (message_id, recipient, status, error_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))
    ON CONFLICT(message_id) DO UPDATE SET
      recipient = COALESCE(excluded.recipient, whatsapp_message_status.recipient),
      status = excluded.status,
      error_json = excluded.error_json,
      updated_at = datetime('now')`)
    .bind(item.messageId, item.recipient || null, item.status, item.error ? JSON.stringify(item.error) : null)
    .run();
}

async function ensureWhatsAppCampaignTable(env) {
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS whatsapp_campaign_sends (
    campaign TEXT NOT NULL,
    recipient TEXT NOT NULL,
    message_id TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (campaign, recipient)
  )`).run();
}

async function ensureManualBillingSendsTable(env) {
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS whatsapp_manual_billing_sends (
    phone TEXT NOT NULL,
    send_date TEXT NOT NULL,
    message_id TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (phone, send_date)
  )`).run();
}

async function ensureWhatsAppInboxTable(env) {
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS whatsapp_inbox_messages (
    message_id TEXT PRIMARY KEY,
    phone TEXT NOT NULL,
    customer_name TEXT,
    direction TEXT NOT NULL,
    message_type TEXT NOT NULL,
    message_text TEXT,
    media_id TEXT,
    created_at TEXT NOT NULL,
    raw_json TEXT
  )`).run();
  await env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_whatsapp_inbox_phone_created ON whatsapp_inbox_messages(phone, created_at DESC)").run();
}

async function ensureWhatsAppAutomationTable(env) {
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS whatsapp_automation_cases (
    id TEXT PRIMARY KEY,
    source_message_id TEXT NOT NULL UNIQUE,
    phone TEXT NOT NULL,
    customer_name TEXT,
    customer_id TEXT,
    case_type TEXT NOT NULL,
    confidence INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'suggested',
    summary TEXT,
    service_month TEXT,
    amount INTEGER,
    media_id TEXT,
    decision_note TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`).run();
  await env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_whatsapp_cases_status_created ON whatsapp_automation_cases(status, created_at DESC)").run();
  await env.DB.prepare("ALTER TABLE whatsapp_automation_cases ADD COLUMN reported_name TEXT").run().catch(() => null);
  await env.DB.prepare("ALTER TABLE whatsapp_automation_cases ADD COLUMN receipt_tx TEXT").run().catch(() => null);
  await env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_whatsapp_cases_receipt_tx ON whatsapp_automation_cases(receipt_tx)").run().catch(() => null);
}

// Verificación del comprobante para quien lo revisa (2026-10-05): el bot lee el monto y el número de operación
// con la IA, los cruza con la deuda pendiente de la planilla y avisa si la operación ya apareció en otro caso.
// NO registra ni marca nada como pagado: solo le da a Carlos la información para decidir más rápido.
function normalizeReceiptTransactionId(value) {
  const id = String(value || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  return id.length >= 6 ? id : null;
}

async function buildReceiptCheck(env, phone, action, caseId) {
  const parts = [];
  const amount = Math.round(Number(action.extracted_amount));
  let pending = [];
  try {
    const row = await env.DB.prepare("SELECT data FROM app_state WHERE id = 'main'").first();
    const state = row?.data ? JSON.parse(row.data) : null;
    pending = (state?.billingRecords || []).filter((record) => normalizeWhatsAppPhone(record.phone) === phone && record.status === "Pendiente");
  } catch { /* sin planilla disponible: se informa solo lo leído */ }
  const money = (value) => `$${Number(value).toLocaleString("es-CL")}`;
  if (Number.isFinite(amount) && amount > 0) {
    const exact = pending.find((record) => Number(record.amount) === amount);
    const total = pending.reduce((sum, record) => sum + (Number(record.amount) || 0), 0);
    if (!pending.length) parts.push(`Monto leído ${money(amount)}; no hay deuda pendiente registrada para este número`);
    else if (exact) parts.push(`Monto leído ${money(amount)}: COINCIDE con ${exact.billingMonth || "un mes"} pendiente`);
    else if (pending.length > 1 && total === amount) parts.push(`Monto leído ${money(amount)}: COINCIDE con la suma de ${pending.length} meses pendientes`);
    else parts.push(`Monto leído ${money(amount)}: NO coincide (pendiente ${pending.map((record) => money(record.amount)).join(" + ")})`);
  } else {
    parts.push("No se pudo leer el monto");
  }
  const tx = normalizeReceiptTransactionId(action.transaction_id);
  if (tx) {
    const duplicate = await env.DB.prepare("SELECT id, phone, created_at FROM whatsapp_automation_cases WHERE receipt_tx = ? AND id != ? LIMIT 1")
      .bind(tx, caseId || "").first().catch(() => null);
    if (duplicate) parts.push(`⚠️ POSIBLE REPETIDO: la operación ${tx} ya apareció en otro caso (${String(duplicate.created_at).slice(0, 10)}, +${duplicate.phone})`);
    if (caseId) await env.DB.prepare("UPDATE whatsapp_automation_cases SET receipt_tx = ? WHERE id = ?").bind(tx, caseId).run().catch(() => null);
  }
  return parts.join(". ");
}

const SPANISH_MONTHS = {
  enero: "01", febrero: "02", marzo: "03", abril: "04", mayo: "05", junio: "06",
  julio: "07", agosto: "08", septiembre: "09", setiembre: "09", octubre: "10", noviembre: "11", diciembre: "12",
};

function inferServiceMonth(text, createdAt) {
  const normalized = String(text || "").toLocaleLowerCase("es-CL");
  const monthName = Object.keys(SPANISH_MONTHS).find((month) => normalized.includes(month));
  if (!monthName) return null;
  const explicitYear = normalized.match(/\b(20\d{2})\b/)?.[1];
  const baseYear = Number(explicitYear || new Date(createdAt).getUTCFullYear());
  return `${baseYear}-${SPANISH_MONTHS[monthName]}`;
}

function inferAmount(text) {
  const candidates = String(text || "").match(/(?:\$\s*)?\b\d{1,3}(?:[.\s]\d{3})+\b|\$\s*\d{4,7}\b/g) || [];
  const values = candidates.map((value) => Number(value.replace(/\D/g, ""))).filter((value) => value >= 1000 && value <= 2000000);
  return values.length ? Math.max(...values) : null;
}

function classifyInboundMessage(message) {
  const text = String(message.text || "").toLocaleLowerCase("es-CL");
  const paymentWords = /\b(pagu[eé]|pago|pagado|transfer|dep[oó]sito|comprobante|boleta)\b/.test(text);
  const faultWords = /\b(sin internet|sin conexi[oó]n|no tengo internet|no funciona|falla|corte|fibra|router|los roja|luz roja|intermitente|lento)\b/.test(text);
  const hasPaymentAttachment = paymentWords && Boolean(message.mediaId) && ["image", "document"].includes(message.type);
  if (paymentWords) {
    return {
      type: "payment",
      confidence: hasPaymentAttachment ? 96 : 70,
      summary: hasPaymentAttachment ? "Comprobante de pago recibido para validación." : "Cliente informa un pago; falta revisar el comprobante.",
      serviceMonth: inferServiceMonth(text, message.createdAt),
      amount: inferAmount(text),
    };
  }
  if (faultWords) {
    return { type: "technical_fault", confidence: 90, summary: "Posible falla de servicio para crear como orden por planificar.", serviceMonth: null, amount: null };
  }
  return { type: "general", confidence: 35, summary: "Consulta general pendiente de atención.", serviceMonth: null, amount: null };
}

// Los comprobantes de WebPay/Transbank suelen llegar como PDF sin caption, con nombres de archivo
// del tipo "webpaycl-comprobantePago-XXXX.pdf": "comprobante" y "Pago" quedan pegados en camelCase,
// sin espacio, así que ninguna regex con límites de palabra (\b) los reconoce como texto de pago.
// Se separa el camelCase y los guiones antes de usar el nombre como texto del mensaje.
function humanizeFilename(filename) {
  return String(filename || "")
    .replace(/\.[a-zA-Z0-9]{2,5}$/, "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim();
}

function inboundMessageText(message) {
  return message.text?.body || message.image?.caption || message.document?.caption || message.button?.text
    || message.interactive?.button_reply?.title || message.interactive?.list_reply?.title
    || (message.document?.filename ? humanizeFilename(message.document.filename) : null) || null;
}

function hasExplicitPaymentIntent(value) {
  return /\b(pagu[eé]|pago|pagado|transferencia|transfer[ií]|dep[oó]sito|comprobante)\b/i.test(String(value || ""));
}

// El cliente suele anteponer una frase antes del nombre real ("Nombre:", "Mi nombre es", "Al
// nombre de", copiando la etiqueta que le mandamos) -- sin quitarla antes de validar, isPlausible
// AccountName la rechazaba completa (por palabras de mas, o puntuacion suelta como el ":" que queda
// tras "Nombre :"), y el bot volvia a pedir un nombre que el cliente ya habia dado.
function extractAccountName(value) {
  let name = String(value || "").trim().slice(0, 200).replace(/\s+/g, " ");
  name = name.replace(/^(mi nombre es|el nombre es|es a nombre de|a nombre de|al nombre de|nombre( del titular)?)\s*:?\s*/i, "").trim();
  name = name.replace(/^[.:,-]+\s*/, "").trim();
  return name;
}

function isPlausibleAccountName(value) {
  const name = String(value || "").trim().replace(/\s+/g, " ");
  if (name.length < 5 || name.length > 120 || /\d|https?:|@/.test(name)) return false;
  const normalized = name.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  if (/^(gracias|listo|si|no|ya|correcto|ese es|esta pagado|ahi esta pagado|ya pague|pagado)(\b|[.!])/i.test(normalized)) return false;
  // Saludos y frases de conversación no son nombres: "Buenos dias" (2 palabras, solo letras) pasaba
  // todos los filtros y se registró una visita "a nombre de Buenos dias".
  if (/^(hola|buenos|buenas|buen|saludos|hey|ok|okay|consulta|quiero|necesito|tengo|perfecto|dale|claro|vale|disculpa|disculpe|oiga|alo)\b/i.test(normalized)) return false;
  const words = name.split(" ").filter(Boolean);
  return words.length >= 2 && words.length <= 6 && words.every((word) => /^[A-Za-zÁÉÍÓÚÜÑáéíóúüñ'-]{2,}$/.test(word));
}

function hasStrongReceiptEvidence(action, message) {
  if (hasExplicitPaymentIntent(message.customerText)) return true;
  // Un PDF solo cuenta como evidencia si la IA realmente lo pudo leer (ver callBotResponder, entrada "file").
  const readable = message.mediaType === "image" || (message.mediaType === "document" && /pdf/i.test(String(message.mediaMime || "")));
  if (!readable || !message.mediaId) return false;
  const evidence = new Set(Array.isArray(action.receipt_evidence) ? action.receipt_evidence : []);
  const identity = ["receipt_title", "bank", "transaction_id"].some((item) => evidence.has(item));
  const transaction = ["amount", "date_time", "recipient", "origin_account", "destination_account"].filter((item) => evidence.has(item)).length;
  return evidence.size >= 3 && identity && transaction >= 2;
}

function normalizeComparablePhone(value) {
  const phone = normalizeWhatsAppPhone(value);
  return phone.length >= 8 ? phone.slice(-8) : phone;
}

async function findCustomerForWhatsApp(env, phone, fallbackName) {
  const row = await env.DB.prepare("SELECT data FROM app_state WHERE id = 'main'").first().catch(() => null);
  const state = row?.data ? JSON.parse(row.data) : null;
  const wanted = normalizeComparablePhone(phone);
  // new Date().getMonth() es hora UTC del runtime, no de Chile -- en la noche (hora Chile) cerca de
  // fin de mes ya sería el mes siguiente en UTC, y el bot buscaría el registro de facturación del
  // mes equivocado al responder "cuánto debo". Se usa chileDateParts() en su lugar.
  const monthName = SPANISH_MONTH_NAMES[chileDateParts().month - 1];
  const billingRecords = (Array.isArray(state?.billingRecords) ? state.billingRecords : []).filter((record) => {
    const candidate = normalizeComparablePhone(record.phone || record.whatsapp || record.telefono || "");
    const recordMonth = String(record.billingMonth || record.month || "").toLocaleLowerCase("es-CL");
    return wanted && candidate === wanted && recordMonth.includes(monthName);
  });
  if (billingRecords.length) {
    const customer = billingRecords[0];
    const rawBalance = customer.amount ?? customer.saldo ?? customer.deuda;
    const hasExplicitBalance = rawBalance !== null && rawBalance !== undefined && String(rawBalance).trim() !== "" && Number.isFinite(Number(rawBalance));
    const status = String(customer.status || "").trim();
    const adjustmentText = [customer.notes, customer.note, customer.observations, customer.adjustment, customer.discount, status].filter(Boolean).join(" ");
    return {
      matchedByPhone: true,
      id: String(customer.id || customer.rut || customer.customerName || ""),
      name: customer.customerName || customer.name || fallbackName || null,
      address: customer.address || customer.direccion || null,
      balance: hasExplicitBalance ? Number(rawBalance) : null,
      dueDate: customer.dueDate || customer.vencimiento || null,
      paymentStatus: status || null,
      billingAuthoritative: billingRecords.length === 1,
      billingAmbiguous: billingRecords.length !== 1 || /descuento|ajuste|revisar|inconsisten/i.test(adjustmentText),
    };
  }
  const billingCustomers = Array.isArray(state?.billingCustomers) ? state.billingCustomers : [];
  const regularCustomers = Array.isArray(state?.customers) ? state.customers : [];
  for (const collection of [billingCustomers, regularCustomers]) {
    for (const customer of collection) {
    const candidate = normalizeComparablePhone(customer.phone || customer.whatsapp || customer.telefono || "");
    if (wanted && candidate && wanted === candidate) {
      const rawBalance = customer.amount ?? customer.saldo ?? customer.deuda;
      const hasExplicitBalance = rawBalance !== null && rawBalance !== undefined && String(rawBalance).trim() !== "" && Number.isFinite(Number(rawBalance));
      const status = String(customer.status || "").trim();
      const adjustmentText = [customer.notes, customer.note, customer.observations, customer.adjustment, customer.discount, status].filter(Boolean).join(" ");
      return {
        matchedByPhone: true,
        id: String(customer.id || customer.rut || customer.name || ""),
        name: customer.name || customer.client || fallbackName || null,
        address: customer.address || customer.direccion || null,
        balance: hasExplicitBalance ? Number(rawBalance) : null,
        dueDate: customer.dueDate || customer.vencimiento || null,
        paymentStatus: status || null,
        billingAuthoritative: false,
        billingAmbiguous: /descuento|ajuste|revisar|inconsisten/i.test(adjustmentText),
      };
    }
    }
  }
  return { matchedByPhone: false, id: null, name: fallbackName || null, address: null, balance: null, dueDate: null, paymentStatus: null, billingAuthoritative: false, billingAmbiguous: false };
}

const LOCATION_REMINDER_MESSAGE = "Necesitamos que nos compartas tu ubicación desde WhatsApp: toca el ícono 📎 (adjuntar) y elige \"Ubicación\". Así podemos revisar la factibilidad exacta.";
const SCHEDULED_INSTALL_STATUSES =["Programada", "Instalacion Programada", "Confirmada"];

// Caso real (2026-10-02, 56990934462): una clienta con la instalación ya programada para ese mismo
// día preguntó "para cuándo nos van a visitar" y el bot la trató como prospecto nuevo (le preguntó
// el sector, le pidió ubicación una y otra vez). Si el teléfono ya es de un cliente registrado con
// una orden de instalación agendada, hay que contestarle desde ahí, no abrirle un embudo de venta.
async function findScheduledInstallation(env, phone) {
  const row = await env.DB.prepare("SELECT data FROM app_state WHERE id = 'main'").first().catch(() => null);
  const state = row?.data ? JSON.parse(row.data) : null;
  const wanted = normalizeComparablePhone(phone);
  if (!state || !wanted) return null;
  const ids = new Set();
  for (const customer of Array.isArray(state.customers) ? state.customers : []) {
    if (normalizeComparablePhone(customer.phone || "") === wanted && customer.id) ids.add(String(customer.id));
  }
  for (const customer of Array.isArray(state.billingCustomers) ? state.billingCustomers : []) {
    if (normalizeComparablePhone(customer.phone || "") === wanted && customer.customerId) ids.add(String(customer.customerId));
  }
  const p = chileDateParts();
  const today = `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
  const orders = (Array.isArray(state.workOrders) ? state.workOrders : [])
    .filter((w) => w?.type === "Instalacion" && ids.has(String(w.customerId)) && SCHEDULED_INSTALL_STATUSES.includes(w.status) && w.plannedDate >= today)
    .sort((a, b) => String(a.plannedDate).localeCompare(String(b.plannedDate)));
  return orders.length ? { plannedDate: orders[0].plannedDate, today, knownCustomer: true } : { knownCustomer: ids.size > 0 };
}

function describeInstallDate(plannedDate, today) {
  if (plannedDate === today) return "hoy";
  const label = new Intl.DateTimeFormat("es-CL", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" }).format(new Date(`${plannedDate}T12:00:00Z`)).replace(",", "");
  return `el ${label}`;
}

async function ensureWhatsAppBotTables(env) {
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS whatsapp_bot_sessions (
    phone TEXT PRIMARY KEY,
    mode TEXT NOT NULL DEFAULT 'bot',
    escalation_reason TEXT,
    updated_by_user_id TEXT,
    updated_by_role TEXT,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`).run();
  await env.DB.prepare("ALTER TABLE whatsapp_bot_sessions ADD COLUMN updated_by_user_id TEXT").run().catch(() => null);
  await env.DB.prepare("ALTER TABLE whatsapp_bot_sessions ADD COLUMN updated_by_role TEXT").run().catch(() => null);
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS whatsapp_bot_session_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    phone TEXT NOT NULL,
    mode TEXT NOT NULL,
    reason TEXT,
    user_id TEXT,
    user_role TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`).run();
  await env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_whatsapp_bot_events_phone_created ON whatsapp_bot_session_events(phone, created_at DESC)").run();
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS whatsapp_visit_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    phone TEXT NOT NULL,
    customer_id TEXT,
    customer_name TEXT,
    reported_name TEXT,
    preferred_date TEXT,
    reason TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`).run();
  await env.DB.prepare("ALTER TABLE whatsapp_visit_requests ADD COLUMN reported_name TEXT").run().catch(() => null);
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS whatsapp_pending_visits (
    phone TEXT PRIMARY KEY,
    reason TEXT,
    preferred_date TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`).run();
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS whatsapp_pending_payments (
    phone TEXT PRIMARY KEY,
    case_id TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`).run();
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS whatsapp_billing_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    phone TEXT NOT NULL,
    customer_id TEXT,
    customer_name TEXT,
    reported_name TEXT,
    days_without_service INTEGER,
    reason TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`).run();
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS whatsapp_pending_billing (
    phone TEXT PRIMARY KEY,
    days_without_service INTEGER,
    reason TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`).run();
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS bpgo_bot_faq (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`).run();
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS whatsapp_sales_leads (
    id TEXT PRIMARY KEY,
    phone TEXT NOT NULL,
    customer_name TEXT,
    sector TEXT,
    plan_group TEXT,
    latitude REAL,
    longitude REAL,
    status TEXT NOT NULL DEFAULT 'awaiting_sector',
    chosen_plan TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`).run();
  await env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_sales_leads_phone ON whatsapp_sales_leads(phone)").run();
  for (const column of ["installation_name", "installation_rut", "installation_phone", "installation_email", "installation_address"]) {
    await env.DB.prepare(`ALTER TABLE whatsapp_sales_leads ADD COLUMN ${column} TEXT`).run().catch(() => null);
  }
  await env.DB.prepare("ALTER TABLE whatsapp_visit_requests ADD COLUMN transcript TEXT").run().catch(() => null);
  await env.DB.prepare("ALTER TABLE whatsapp_billing_requests ADD COLUMN transcript TEXT").run().catch(() => null);
}

async function ensureWhatsAppBotProcessedTable(env) {
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS whatsapp_bot_processed_inbound (
    message_id TEXT PRIMARY KEY,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`).run();
}

// Meta reentrega el mismo webhook si no respondemos a tiempo o hay un reintento de su lado ("at
// least once"). Sin esta marca, cada reentrega volvía a pasar por la IA (respuesta distinta cada
// vez, no determinística) y a re-ejecutar acciones sensibles como confirmar un pago por botón,
// generando respuestas duplicadas al cliente o pagos aplicados dos veces. true = primera vez que
// se ve este message_id (seguir procesando); false = ya se procesó, se debe saltar.
async function claimInboundMessageForBot(env, messageId) {
  await ensureWhatsAppBotProcessedTable(env);
  const result = await env.DB.prepare("INSERT OR IGNORE INTO whatsapp_bot_processed_inbound (message_id) VALUES (?)").bind(messageId).run();
  return Boolean(result.meta?.changes);
}

// Arma un texto legible con los últimos mensajes reales del cliente (y las preguntas del bot) para
// que Operaciones vea el detalle exacto de lo que se conversó -- un resumen de una línea escrito
// por el modelo puede perder matices ("qué luz tiene el router", "desde cuándo", etc.) que sí
// importan para diagnosticar en terreno.
async function buildRecentTranscript(env, phone, limit) {
  await ensureWhatsAppInboxTable(env);
  const rows = await env.DB.prepare(`SELECT direction, message_type, message_text, created_at
    FROM whatsapp_inbox_messages WHERE phone = ? ORDER BY created_at DESC LIMIT ?`).bind(phone, limit || 20).all();
  const lines = (rows.results || []).reverse().map((row) => {
    const who = row.direction === "inbound" ? "Cliente" : "BPGO";
    const text = row.message_text || (row.message_type === "image" ? "[imagen]" : row.message_type === "audio" ? "[audio]" : `[${row.message_type}]`);
    return `${who}: ${text}`;
  });
  return lines.join("\n").slice(0, 3000);
}

async function getBotSessionRow(env, phone) {
  await ensureWhatsAppBotTables(env);
  return env.DB.prepare("SELECT mode, escalation_reason, updated_by_user_id, updated_by_role, updated_at FROM whatsapp_bot_sessions WHERE phone = ?").bind(phone).first();
}

async function getBotSessionMode(env, phone) {
  const row = await getBotSessionRow(env, phone);
  return row?.mode === "human" ? "human" : "bot";
}

const AUTO_REACTIVATE_AFTER_MS = 45 * 60 * 1000;

// Solo se reactiva sola una sesión que quedó en modo humano porque alguien de BPGO tomó la
// conversación DIRECTAMENTE (respondió manual desde el panel o desde la app de WhatsApp Business)
// -- nunca cuando el motivo fue que el bot creó un caso de negocio (pago/visita/descuento/
// contratación) que sigue esperando que Carlos lo revise explícitamente; esos casos deben seguir
// congelados hasta reactivación manual, tal como antes. Se exige además que haya pasado el tiempo
// mínimo desde la ÚLTIMA actividad real de la conversación (no desde que se activó el modo humano),
// para no reactivar el bot mientras un humano sigue escribiendo activamente.
const AUTO_REACTIVATABLE_REASONS = new Set(["manual_reply", "manual_whatsapp_reply", "manual_takeover", "bot_exception"]);

// Caso real (2026-10-06, 56948037190): una conversación quedó "congelada" por un comprobante el 20 de septiembre y
// 16 días después la clienta escribió "Abra alguna cuenta para pagar mi plan" y el bot calló. Un bloqueo humano
// que lleva horas sin NINGUNA actividad (ni del cliente ni del equipo) ya no es una conversación atendida: es un
// bloqueo olvidado. Con cualquier motivo, si pasaron STALE_HUMAN_LOCK_MS sin actividad, el bot retoma al tiro.
const STALE_HUMAN_LOCK_MS = 6 * 60 * 60 * 1000;

async function shouldAutoReactivate(env, phone, session, currentMessageId) {
  if (!session || session.mode !== "human") return false;
  const lastMessage = await env.DB.prepare(
    "SELECT created_at FROM whatsapp_inbox_messages WHERE phone = ? AND message_id != ? ORDER BY created_at DESC LIMIT 1"
  ).bind(phone, currentMessageId || "").first();
  const lastActivityMs = lastMessage ? Date.parse(lastMessage.created_at) : NaN;
  const sessionMs = parseSqliteDatetime(session.updated_at);
  const staleLock = Number.isFinite(sessionMs) && Date.now() - sessionMs >= STALE_HUMAN_LOCK_MS
    && (!Number.isFinite(lastActivityMs) || Date.now() - lastActivityMs >= STALE_HUMAN_LOCK_MS);
  if (staleLock) return true;
  if (!AUTO_REACTIVATABLE_REASONS.has(session.escalation_reason)) return false;
  if (!lastMessage) return false;
  return Number.isFinite(lastActivityMs) && Date.now() - lastActivityMs >= AUTO_REACTIVATE_AFTER_MS;
}

// Al liberar un bloqueo olvidado de un trámite sensible, el bot vuelve a contestar pero no deja
// que la IA improvise sobre la revisión de pagos, visitas ni facturación.
function safeReplyForReactivatedBusinessHandoff(reason) {
  if (reason === "case_created_payment") return "Tu comprobante sigue en revisión. Apenas esté validado te confirmaremos por este medio.";
  if (reason === "case_created_visit") return "Tu solicitud de visita sigue en revisión. Un agente te confirmará la coordinación por este medio.";
  if (reason === "case_created_billing") return "Tu solicitud sobre facturación sigue en revisión. Un agente te confirmará por este medio.";
  if (reason === "bot_escalated") return "Tu solicitud sigue en revisión. Un agente te responderá por este medio.";
  return null;
}

// Caso real (2026-10-05, 56920144998): un cliente en modo humano escribió "Algún ejecutivo para hablar"
// y durante ~13 minutos nadie respondió ni se enteró: con la conversación en modo humano el bot calla
// (correcto), pero tampoco se avisaba a Carlos de que el cliente había escrito. Ahora llega UN aviso
// por cliente cada hora como máximo, y ninguno si ya se le respondió hace menos de 30 minutos (es
// decir, si un humano está atendiendo la conversación en este momento).
const HUMAN_MODE_ALERT_COOLDOWN_MIN = 60;
const HUMAN_MODE_RECENT_REPLY_MIN = 30;

async function alertStaffCustomerWroteInHumanMode(env, credentials, phone, message) {
  const recentAlert = await env.DB.prepare(
    `SELECT 1 AS found FROM staff_notifications_log WHERE customer_phone = ? AND case_type = 'Cliente en atención humana'
     AND created_at > datetime('now', ?) LIMIT 1`
  ).bind(phone, `-${HUMAN_MODE_ALERT_COOLDOWN_MIN} minutes`).first();
  if (recentAlert) return false;
  const lastOutbound = await env.DB.prepare(
    "SELECT created_at FROM whatsapp_inbox_messages WHERE phone = ? AND direction = 'outbound' ORDER BY created_at DESC LIMIT 1"
  ).bind(phone).first();
  const lastOutboundMs = lastOutbound?.created_at ? parseSqliteDatetime(lastOutbound.created_at) : NaN;
  if (Number.isFinite(lastOutboundMs) && Date.now() - lastOutboundMs < HUMAN_MODE_RECENT_REPLY_MIN * 60 * 1000) return false;
  const text = String(inboundMessageText(message) || "").trim();
  const name = await getKnownAccountName(env, phone).catch(() => null);
  await notifyStaff(env, credentials, "carlos", "Cliente en atención humana", name, phone,
    text ? `Escribió y el bot no responde porque la conversación está en atención humana: "${text.slice(0, 180)}"` : "Escribió (adjunto o mensaje sin texto) y el bot no responde porque la conversación está en atención humana.",
    { sourceMessageId: message.id });
  return true;
}

// Regla del negocio (reiterada por Carlos 2026-10-05): si nadie del equipo atiende al cliente durante unos
// minutos, el bot retoma la conversación de inmediato. Antes la única reactivación era por inactividad
// (45 min) y solo para tomas manuales; un cliente en modo humano que escribía y no recibía respuesta
// quedaba mudo indefinidamente. Ahora, si el ÚLTIMO mensaje de la conversación es del cliente (texto),
// lleva sin respuesta >= HUMAN_NO_RESPONSE_TAKEOVER_MS y el modo humano tampoco se fijó en ese lapso (para
// no pisar a alguien que acaba de tomar el chat desde el panel), el bot vuelve y responde ESE mensaje.
// Los adjuntos (posibles comprobantes) nunca se reprocesan así. Se evalúa al final de cada webhook de Meta
// y en la corrida de 10 minutos de GitHub Actions; claimInboundMessageForBot impide responder dos veces.
const HUMAN_NO_RESPONSE_TAKEOVER_MS = 5 * 60 * 1000;
// 23 h: pasada la ventana de 24 h de WhatsApp ya no se puede escribir texto libre (solo plantillas), así que
// no tiene sentido intentar más allá.
const HUMAN_NO_RESPONSE_MAX_AGE_MS = 23 * 60 * 60 * 1000;
const HUMAN_NO_RESPONSE_BATCH = 3;

// "Ya perfecto gracias" después de que un humano resolvió no necesita que el bot vuelva a contestar.
function isClosingPleasantry(text) {
  const normalized = cyberNormalize(text).replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
  return normalized.length <= 40 && /^((ya|ok|okey|okay|listo|perfecto|vale|dale|bueno|bien|excelente|genial|super|muy bien|muchas|mil|gracias|de nada|saludos|chao|adios|hasta luego|un abrazo)( |$))+$/.test(normalized);
}

async function takeOverUnansweredHumanChats(env) {
  if (String(env.WHATSAPP_BOT_ENABLED || "").toLowerCase() !== "true") return { ok: true, taken: 0 };
  await ensureWhatsAppBotTables(env);
  await ensureWhatsAppInboxTable(env);
  const now = Date.now();
  const newestAllowed = new Date(now - HUMAN_NO_RESPONSE_TAKEOVER_MS).toISOString();
  const oldestAllowed = new Date(now - HUMAN_NO_RESPONSE_MAX_AGE_MS).toISOString();
  const sessionCutoff = newestAllowed.replace("T", " ").slice(0, 19);
  const rows = await env.DB.prepare(`SELECT s.phone, s.escalation_reason, m.message_id, m.message_text, m.created_at
    FROM whatsapp_bot_sessions s JOIN whatsapp_inbox_messages m ON m.phone = s.phone
    WHERE s.mode = 'human' AND s.updated_at <= ? AND m.direction = 'inbound' AND m.message_type = 'text'
      AND COALESCE(TRIM(m.message_text), '') != '' AND m.created_at <= ? AND m.created_at >= ?
      AND m.created_at = (SELECT MAX(created_at) FROM whatsapp_inbox_messages WHERE phone = s.phone)
    ORDER BY m.created_at ASC LIMIT ?`).bind(sessionCutoff, newestAllowed, oldestAllowed, HUMAN_NO_RESPONSE_BATCH).all();
  const staffPhones = new Set([env.STAFF_PHONE_CARLOS, env.STAFF_PHONE_EDUARDO].map((value) => normalizeWhatsAppPhone(value)).filter(Boolean));
  let taken = 0;
  for (const row of rows.results || []) {
    if (staffPhones.has(row.phone) || isClosingPleasantry(row.message_text)) continue;
    // OJO: runBotForInboundMessages ya hace su propio claim de `retake:<id>` (el id del mensaje sintético).
    // Si acá se reclamara ese mismo id, el bot lo vería como "ya procesado" y saltaría el mensaje: la sesión
    // volvía a modo bot pero NUNCA se respondía (bug real 2026-10-05, 56945234071). Por eso esta marca usa
    // otra clave: solo impide que dos corridas retomen el mismo mensaje a la vez.
    if (!(await claimInboundMessageForBot(env, `retake-claim:${row.message_id}`))) continue;
    await setBotSessionMode(env, row.phone, "bot", "auto_reactivated_unanswered");
    taken += 1;
    await runBotForInboundMessages(env, [{ value: { contacts: [{ profile: {} }], messages: [
      { id: `retake:${row.message_id}`, from: row.phone, type: "text", text: { body: row.message_text }, reactivatedHandoffReason: row.escalation_reason },
    ] } }]).catch(() => null);
  }
  return { ok: true, taken };
}

// Auditoría 2026-10-05: había clientes con consultas reales ("sabes por qué no tengo internet", "q pasa
// con la tv", un audio) sin respuesta hace 1-3 días, en conversaciones que ya no recupera el bot (fuera de
// la ventana de 24 h) y cuyo aviso individual falló o nunca existió. Cada ~10 min (corrida de GitHub
// Actions) se manda a Carlos UN resumen -- como mucho cada 3 horas, por el espaciado de Meta -- con los
// chats cuyo último mensaje es del cliente (texto/audio/imagen/documento) y llevan > 30 min sin respuesta.
const UNANSWERED_DIGEST_AFTER_MIN = 30;
const UNANSWERED_DIGEST_COOLDOWN_HOURS = 3;
const UNANSWERED_DIGEST_MAX_AGE_HOURS = 72;

async function alertStaffUnansweredChats(env) {
  await ensureWhatsAppBotTables(env);
  await ensureWhatsAppInboxTable(env);
  await ensureStaffNotificationsLogTable(env);
  const recent = await env.DB.prepare(
    "SELECT 1 AS found FROM staff_notifications_log WHERE case_type = 'Chats sin responder' AND created_at > datetime('now', ?) LIMIT 1"
  ).bind(`-${UNANSWERED_DIGEST_COOLDOWN_HOURS} hours`).first();
  if (recent) return { ok: true, sent: false, reason: "cooldown" };
  const rows = await env.DB.prepare(`SELECT m.phone, m.created_at AS last_at, m.message_type, m.message_text
    FROM whatsapp_inbox_messages m
    WHERE m.direction = 'inbound' AND m.message_type IN ('text', 'audio', 'image', 'document')
      AND m.created_at <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ?) AND m.created_at >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ?)
      AND m.created_at = (SELECT MAX(created_at) FROM whatsapp_inbox_messages WHERE phone = m.phone)
    ORDER BY m.created_at ASC LIMIT 40`)
    .bind(`-${UNANSWERED_DIGEST_AFTER_MIN} minutes`, `-${UNANSWERED_DIGEST_MAX_AGE_HOURS} hours`).all();
  const staffPhones = new Set([env.STAFF_PHONE_CARLOS, env.STAFF_PHONE_EDUARDO].map((value) => normalizeWhatsAppPhone(value)).filter(Boolean));
  // Un "gracias" final o la respuesta automática de otra empresa no son clientes esperando respuesta.
  const waiting = (rows.results || []).filter((row) => !staffPhones.has(row.phone)
    && !(row.message_type === "text" && (isClosingPleasantry(row.message_text) || isLikelyAutoReply(row.message_text))));
  if (!waiting.length) return { ok: true, sent: false, reason: "none" };
  const list = waiting.slice(0, 6).map((row) => `+${row.phone}`).join(", ");
  const credentials = await getWhatsAppCredentials(env);
  const result = await notifyStaff(env, credentials, "carlos", "Chats sin responder", "Varios clientes", "interno",
    `${waiting.length} cliente(s) esperan respuesta hace más de ${UNANSWERED_DIGEST_AFTER_MIN} min: ${list}${waiting.length > 6 ? " y más" : ""}. Revisa la bandeja de WhatsApp.`,
    { sourceMessageId: `digest-${new Date().toISOString().slice(0, 13)}` });
  return { ok: true, sent: true, waiting: waiting.length, result };
}

async function setBotSessionMode(env, phone, mode, reason, actor) {
  await ensureWhatsAppBotTables(env);
  const userId = actor?.userId ? String(actor.userId) : null;
  const userRole = actor?.role ? String(actor.role) : null;
  await env.DB.prepare(`INSERT INTO whatsapp_bot_sessions
    (phone, mode, escalation_reason, updated_by_user_id, updated_by_role, updated_at)
    VALUES (?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(phone) DO UPDATE SET mode = excluded.mode, escalation_reason = excluded.escalation_reason,
      updated_by_user_id = excluded.updated_by_user_id, updated_by_role = excluded.updated_by_role,
      updated_at = datetime('now')`)
    .bind(phone, mode, reason || null, userId, userRole).run();
  await env.DB.prepare(`INSERT INTO whatsapp_bot_session_events
    (phone, mode, reason, user_id, user_role, created_at) VALUES (?, ?, ?, ?, ?, datetime('now'))`)
    .bind(phone, mode, reason || null, userId, userRole).run();
}

const DEFAULT_BOT_FAQ = [
  "BPGO es un proveedor de internet y TV cable.",
  "Horario de atención: lunes a viernes de 9:00 a 18:00, sábados de 9:00 a 13:00.",
  "Portal oficial para pagar la mensualidad o el plan: https://bpgo.cl/pagar",
  "Para enviar un comprobante de pago, el cliente puede mandar la foto o PDF directamente por este chat.",
  "Este contenido es un ejemplo por defecto: edítalo desde el panel de operaciones (Solicitudes de visita / FAQ del bot) con la información real de BPGO (planes, direcciones, políticas).",
].join("\n");

async function getBotFaqText(env) {
  await ensureWhatsAppBotTables(env);
  const rows = await env.DB.prepare("SELECT key, value FROM bpgo_bot_faq ORDER BY key ASC").all();
  const items = rows.results || [];
  if (!items.length) return DEFAULT_BOT_FAQ;
  return items.map((item) => `${item.key}: ${item.value}`).join("\n");
}

async function buildBotContext(env, phone, fallbackName) {
  await ensureWhatsAppInboxTable(env);
  // Cuando un operador reactiva explícitamente el bot, no se le muestra al modelo el historial
  // anterior a esa reactivación. Así una consulta nueva no hereda un caso humano ya cerrado.
  const session = await getBotSessionRow(env, phone);
  const reactivatedAt = session && session.mode !== "human"
    && session.escalation_reason === "manual_reactivated"
    ? Date.parse(session.updated_at.includes("T") ? session.updated_at : `${session.updated_at.replace(" ", "T")}Z`)
    : null;
  // Comparar como texto fallaba: whatsapp_inbox_messages.created_at es ISO ("...T...Z") pero
  // whatsapp_bot_sessions.updated_at usa datetime('now') de SQLite ("YYYY-MM-DD HH:MM:SS") --
  // formatos distintos hacían que el filtro por fecha nunca funcionara como texto. Se filtra acá
  // en JS con fechas reales en vez de confiar en la comparación de strings en SQL.
  const historyRows = await env.DB.prepare(`SELECT direction, message_type, message_text, created_at
    FROM whatsapp_inbox_messages WHERE phone = ? ORDER BY created_at DESC LIMIT 20`).bind(phone).all();
  let history = (historyRows.results || []).reverse();
  if (reactivatedAt && Number.isFinite(reactivatedAt)) {
    history = history.filter((row) => Date.parse(row.created_at) >= reactivatedAt);
  }
  history = history.slice(-10);
  const customer = await findCustomerForWhatsApp(env, phone, fallbackName);
  const faq = await getBotFaqText(env);
  await ensureWhatsAppAutomationTable(env);
  const pendingReceipt = await env.DB.prepare(`SELECT 1 AS found FROM whatsapp_automation_cases
    WHERE phone=? AND case_type='payment' AND status IN ('suggested','reviewing') LIMIT 1`).bind(phone).first();
  return { history, customer, faq, hasPendingReceipt: Boolean(pendingReceipt) };
}

async function fetchWhatsAppMediaBytes(credentials, mediaId) {
  const metadataResponse = await fetch(`https://graph.facebook.com/v25.0/${encodeURIComponent(mediaId)}`, {
    headers: { authorization: `Bearer ${credentials.accessToken}` },
  });
  const metadata = await metadataResponse.json().catch(() => ({}));
  if (!metadataResponse.ok || !metadata.url) return null;
  const mediaResponse = await fetch(metadata.url, { headers: { authorization: `Bearer ${credentials.accessToken}` } });
  if (!mediaResponse.ok) return null;
  return {
    bytes: new Uint8Array(await mediaResponse.arrayBuffer()),
    mimeType: metadata.mime_type || mediaResponse.headers.get("content-type") || "application/octet-stream",
  };
}

async function fetchWhatsAppMediaBase64(credentials, mediaId) {
  const media = await fetchWhatsAppMediaBytes(credentials, mediaId);
  if (!media) return null;
  let binary = "";
  for (let index = 0; index < media.bytes.length; index += 1) binary += String.fromCharCode(media.bytes[index]);
  return { base64: btoa(binary), mimeType: media.mimeType };
}

async function transcribeWhatsAppAudio(env, credentials, mediaId) {
  if (!env.OPENAI_API_KEY) return null;
  const media = await fetchWhatsAppMediaBytes(credentials, mediaId).catch(() => null);
  if (!media) return null;
  const extension = media.mimeType.includes("mp4") ? "m4a" : media.mimeType.includes("mpeg") ? "mp3" : "ogg";
  const form = new FormData();
  form.append("file", new Blob([media.bytes], { type: media.mimeType }), `audio.${extension}`);
  form.append("model", "whisper-1");
  form.append("language", "es");
  const response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { authorization: `Bearer ${env.OPENAI_API_KEY}` },
    body: form,
  }).catch(() => null);
  if (!response || !response.ok) return null;
  const payload = await response.json().catch(() => ({}));
  return String(payload.text || "").trim() || null;
}

async function synthesizeSpeech(env, text) {
  if (!env.OPENAI_API_KEY) return null;
  const response = await fetch("https://api.openai.com/v1/audio/speech", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${env.OPENAI_API_KEY}` },
    body: JSON.stringify({ model: "tts-1", voice: "nova", input: text.slice(0, 3000), response_format: "mp3" }),
  }).catch(() => null);
  if (!response || !response.ok) return null;
  return new Uint8Array(await response.arrayBuffer());
}

async function sendWhatsAppAudio(env, credentials, phone, audioBytes) {
  const uploadForm = new FormData();
  uploadForm.append("messaging_product", "whatsapp");
  uploadForm.append("file", new Blob([audioBytes], { type: "audio/mpeg" }), "respuesta.mp3");
  uploadForm.append("type", "audio/mpeg");
  const uploadResponse = await fetch(`https://graph.facebook.com/v25.0/${encodeURIComponent(credentials.phoneNumberId)}/media`, {
    method: "POST",
    headers: { authorization: `Bearer ${credentials.accessToken}` },
    body: uploadForm,
  }).catch(() => null);
  const uploadPayload = uploadResponse ? await uploadResponse.json().catch(() => ({})) : {};
  const mediaId = uploadPayload.id;
  if (!uploadResponse?.ok || !mediaId) return { ok: false };
  const endpoint = `https://graph.facebook.com/v25.0/${encodeURIComponent(credentials.phoneNumberId)}/messages`;
  const metaResponse = await fetch(endpoint, {
    method: "POST",
    headers: { authorization: `Bearer ${credentials.accessToken}`, "content-type": "application/json" },
    body: JSON.stringify({ messaging_product: "whatsapp", recipient_type: "individual", to: phone, type: "audio", audio: { id: mediaId } }),
  });
  const meta = await metaResponse.json().catch(() => ({}));
  const messageId = meta.messages?.[0]?.id;
  if (metaResponse.ok && messageId) {
    await ensureWhatsAppInboxTable(env);
    await env.DB.prepare(`INSERT OR IGNORE INTO whatsapp_inbox_messages
      (message_id, phone, direction, message_type, message_text, created_at, raw_json)
      VALUES (?, ?, 'outbound', 'audio', NULL, ?, ?)`)
      .bind(messageId, phone, new Date().toISOString(), JSON.stringify(meta)).run();
  }
  return { ok: metaResponse.ok, messageId };
}

async function ensureStaffNotificationsLogTable(env) {
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS staff_notifications_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    role TEXT, staff_phone TEXT, case_type TEXT, customer_phone TEXT,
    ok INTEGER, http_status INTEGER, response_json TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`).run();
  const columns = [
    ["idempotency_key", "TEXT"], ["template_name", "TEXT"], ["template_language", "TEXT"],
    ["customer_name", "TEXT"], ["entity_type", "TEXT"], ["entity_id", "TEXT"],
    ["source_message_id", "TEXT"], ["summary", "TEXT"], ["status", "TEXT NOT NULL DEFAULT 'pending'"],
    ["message_id", "TEXT"], ["error_code", "TEXT"], ["error_message", "TEXT"],
    ["error_details", "TEXT"], ["attempt_count", "INTEGER NOT NULL DEFAULT 0"],
    ["last_attempt_at", "TEXT"], ["updated_at", "TEXT"],
    ["attempted_template", "TEXT"], ["final_template", "TEXT"], ["fallback_used", "INTEGER NOT NULL DEFAULT 0"],
    ["fallback_message_id", "TEXT"], ["original_error_code", "TEXT"], ["original_error_message", "TEXT"],
    ["original_error_details", "TEXT"], ["error_subcode", "TEXT"], ["fbtrace_id", "TEXT"],
    ["original_error_subcode", "TEXT"], ["original_fbtrace_id", "TEXT"],
    ["primary_http_status", "INTEGER"], ["fallback_http_status", "INTEGER"],
    ["primary_response_json", "TEXT"], ["fallback_response_json", "TEXT"],
  ];
  for (const [name, type] of columns) {
    await env.DB.prepare(`ALTER TABLE staff_notifications_log ADD COLUMN ${name} ${type}`).run().catch(() => null);
  }
  await env.DB.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_staff_notifications_idempotency ON staff_notifications_log(idempotency_key)").run();
  await env.DB.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_staff_notifications_message ON staff_notifications_log(message_id) WHERE message_id IS NOT NULL").run();
}

function staffNotificationIdentity(role, caseType, options = {}) {
  if (options.caseId) return { type: "case", id: String(options.caseId), key: `${role}:case:${options.caseId}` };
  if (options.visitRequestId) return { type: "visit_request", id: String(options.visitRequestId), key: `${role}:visit:${options.visitRequestId}` };
  if (options.billingRequestId) return { type: "billing_request", id: String(options.billingRequestId), key: `${role}:billing:${options.billingRequestId}` };
  if (options.factibilidadLeadId) return { type: "lead", id: String(options.factibilidadLeadId), key: `${role}:factibilidad:${options.factibilidadLeadId}` };
  if (options.leadId) return { type: "lead", id: String(options.leadId), key: `${role}:contratacion:${options.leadId}` };
  if (options.sourceMessageId) return { type: "source_message", id: String(options.sourceMessageId), key: `${role}:mensaje:${options.sourceMessageId}:${caseType}` };
  return null;
}

function sanitizeStaffTemplateParam(value, maxLength = 300) {
  return String(value || "").replace(/[\n\t\r]+/g, " ").replace(/\s{2,}/g, " ").trim().slice(0, maxLength);
}

function staffMetaError(body) {
  const error = body?.error || {};
  return {
    code: error.code == null ? null : String(error.code),
    subcode: error.error_subcode == null ? null : String(error.error_subcode),
    message: error.message || null,
    details: error.error_data?.details || error.error_user_msg || null,
    fbtraceId: error.fbtrace_id || null,
  };
}

function sanitizeMetaDiagnostic(value) {
  if (Array.isArray(value)) return value.map(sanitizeMetaDiagnostic);
  if (!value || typeof value !== "object") return value;
  const clean = {};
  for (const [key, item] of Object.entries(value)) {
    if (/token|secret|authorization|password/i.test(key)) clean[key] = "[REDACTED]";
    else clean[key] = sanitizeMetaDiagnostic(item);
  }
  return clean;
}

function parseStoredJson(value) {
  try { return value ? JSON.parse(value) : null; } catch { return null; }
}

function classifyStaffMetaFailure(primaryBody, fallbackBody) {
  const primary = staffMetaError(primaryBody);
  const fallback = staffMetaError(fallbackBody);
  if (primary.code === "131042" && fallback.code === "131042") {
    return { type: "waba_payment_eligibility", label: "Bloqueo de cuenta Meta, no de plantilla", conclusive: true };
  }
  if (primary.code === "131042" || fallback.code === "131042") {
    return { type: "waba_payment_eligibility", label: "Meta reporta un bloqueo de elegibilidad/pago de la cuenta", conclusive: true };
  }
  if (primary.code && fallback.code && primary.code === fallback.code) {
    return { type: "account_or_configuration", label: "PRIMARY y FALLBACK reciben el mismo rechazo de Meta", conclusive: false };
  }
  return { type: "undetermined", label: "Revisar respuestas PRIMARY y FALLBACK", conclusive: false };
}

async function metaDiagnosticRequest(credentials, path) {
  if (!credentials?.accessToken) return { ok: false, httpStatus: 0, body: { error: { message: "Credencial de Meta ausente." } } };
  const response = await fetch(`https://graph.facebook.com/v25.0/${path}`, {
    headers: { authorization: `Bearer ${credentials.accessToken}` },
  }).catch((error) => ({ ok: false, status: 0, json: async () => ({ error: { message: String(error?.message || error) } }) }));
  const body = await response.json().catch(() => ({}));
  return { ok: Boolean(response.ok), httpStatus: Number(response.status || 0), body: sanitizeMetaDiagnostic(body) };
}

async function deliverStaffNotification(env, credentials, row) {
  const normalized = normalizeWhatsAppPhone(row.staff_phone);
  const configurationError = !/^\d{8,15}$/.test(String(normalized || "")) ? "Número del responsable inválido o ausente."
    : !credentials?.accessToken || !credentials?.phoneNumberId ? "Credenciales de WhatsApp incompletas." : null;
  if (configurationError) {
    await env.DB.prepare(`UPDATE staff_notifications_log SET status='failed', ok=0, http_status=NULL,
      error_code='configuration_error', error_message=?, error_details=NULL, attempt_count=COALESCE(attempt_count,0)+1,
      last_attempt_at=datetime('now'), updated_at=datetime('now') WHERE id=?`).bind(configurationError, row.id).run();
    return { ok: false, status: "failed", error: configurationError };
  }
  const endpoint = `https://graph.facebook.com/v25.0/${encodeURIComponent(credentials.phoneNumberId)}/messages`;
  async function sendTemplate(templateName) {
    const components = [{ type: "body", parameters: [
      { type: "text", text: sanitizeStaffTemplateParam(row.case_type, 120) || "Caso interno" },
      { type: "text", text: sanitizeStaffTemplateParam(row.customer_name, 160) || "Sin identificar" },
      { type: "text", text: sanitizeStaffTemplateParam(row.customer_phone, 30) || "Sin teléfono" },
      { type: "text", text: sanitizeStaffTemplateParam(row.summary, 300) || "Sin detalle" },
    ] }];
    if (templateName === "aviso_nuevo_pago" && row.entity_type === "case" && row.entity_id) {
      components.push({ type: "button", sub_type: "quick_reply", index: 0, parameters: [{ type: "payload", payload: `confirm_payment:${row.entity_id}` }] });
    } else if (templateName === "aviso_factibilidad" && row.entity_id) {
      components.push({ type: "button", sub_type: "quick_reply", index: 0, parameters: [{ type: "payload", payload: `factibilidad_yes:${row.entity_id}` }] });
      components.push({ type: "button", sub_type: "quick_reply", index: 1, parameters: [{ type: "payload", payload: `factibilidad_no:${row.entity_id}` }] });
    }
    return fetch(endpoint, { method: "POST", headers: { authorization: `Bearer ${credentials.accessToken}`, "content-type": "application/json" }, body: JSON.stringify({
      messaging_product: "whatsapp", recipient_type: "individual", to: normalized, type: "template",
      template: { name: templateName, language: { code: row.template_language || "es_CL" }, components },
    }) }).then(async (response) => ({ status: response.status, ok: response.ok, body: await response.json().catch(() => null) }))
      .catch((error) => ({ status: 0, ok: false, body: { error: { message: String(error?.message || error) } } }));
  }
  const primaryTemplate = row.template_name;
  const primary = await sendTemplate(primaryTemplate);
  const primaryMessageId = primary.body?.messages?.[0]?.id || null;
  const primaryAccepted = Boolean(primary.ok && primaryMessageId);
  const primaryError = staffMetaError(primary.body);
  const canFallback = !primaryAccepted && primaryTemplate !== "aviso_nuevo_caso" && primary.status >= 400;
  const fallback = canFallback ? await sendTemplate("aviso_nuevo_caso") : null;
  const fallbackMessageId = fallback?.body?.messages?.[0]?.id || null;
  const fallbackAccepted = Boolean(fallback?.ok && fallbackMessageId);
  const finalResult = fallback || primary;
  const messageId = fallbackAccepted ? fallbackMessageId : primaryMessageId;
  const accepted = primaryAccepted || fallbackAccepted;
  const finalError = staffMetaError(finalResult.body);
  const finalTemplate = fallback ? "aviso_nuevo_caso" : primaryTemplate;
  await env.DB.prepare(`UPDATE staff_notifications_log SET status=?, ok=?, http_status=?, message_id=?, error_code=?, error_subcode=?, fbtrace_id=?,
    error_message=?, error_details=?, response_json=?, attempt_count=COALESCE(attempt_count,0)+?, attempted_template=?,
    final_template=?, fallback_used=?, fallback_message_id=?, original_error_code=?, original_error_message=?,
    original_error_details=?, original_error_subcode=?, original_fbtrace_id=?, primary_http_status=?, fallback_http_status=?,
    primary_response_json=?, fallback_response_json=?, last_attempt_at=datetime('now'), updated_at=datetime('now') WHERE id=?`)
    .bind(accepted ? "accepted" : "failed", accepted ? 1 : 0, finalResult.status, messageId,
      accepted ? null : finalError.code, accepted ? null : finalError.subcode, accepted ? null : finalError.fbtraceId,
      accepted ? null : (finalError.message || "Meta no devolvió un message_id."),
      accepted ? null : finalError.details, JSON.stringify({ primary: primary.body, fallback: fallback?.body || null }),
      fallback ? 2 : 1, primaryTemplate, finalTemplate, fallback ? 1 : 0, fallbackMessageId,
      primaryAccepted ? null : primaryError.code, primaryAccepted ? null : primaryError.message,
      primaryAccepted ? null : primaryError.details, primaryAccepted ? null : primaryError.subcode,
      primaryAccepted ? null : primaryError.fbtraceId, primary.status, fallback?.status || null,
      JSON.stringify(sanitizeMetaDiagnostic(primary.body)), fallback ? JSON.stringify(sanitizeMetaDiagnostic(fallback.body)) : null,
      row.id).run();
  if (accepted) await saveWhatsAppStatus(env, { messageId, recipient: normalized, status: "accepted" }).catch(() => null);
  return { ok: accepted, status: accepted ? "accepted" : "failed", messageId, fallbackUsed: Boolean(fallback), error: accepted ? null : finalError };
}

// Meta empezó a rechazar avisos a Carlos con "This message was not delivered to maintain healthy
// ecosystem engagement" -- su número recibía una plantilla por cada comprobante nuevo, a veces
// varias en minutos, y Meta lo trata como spam del mismo remitente. En vez de mandar cada aviso al
// tiro, se espacian: si ya se intentó un envío a ese rol hace menos de STAFF_NOTIFICATION_PACING_MS,
// el aviso queda 'pending' en la cola y lo despacha flushQueuedStaffNotifications() en el próximo
// tick disponible (se llama sola al final de cada webhook de Meta, que llega seguido).
const STAFF_NOTIFICATION_PACING_MS = 90 * 1000;

function parseSqliteDatetime(value) {
  if (!value) return NaN;
  return Date.parse(String(value).includes("T") ? value : `${value.replace(" ", "T")}Z`);
}

async function lastStaffNotificationAttemptMs(env, role) {
  const row = await env.DB.prepare(
    "SELECT last_attempt_at FROM staff_notifications_log WHERE role=? AND last_attempt_at IS NOT NULL ORDER BY last_attempt_at DESC LIMIT 1"
  ).bind(role).first();
  return row?.last_attempt_at ? parseSqliteDatetime(row.last_attempt_at) : 0;
}

async function notifyStaff(env, credentials, role, caseType, customerName, customerPhone, summary, options = {}) {
  try {
    await ensureStaffNotificationsLogTable(env);
    const identity = staffNotificationIdentity(role, caseType, options);
    if (!identity) throw new Error(`Falta identificador idempotente para ${role}/${caseType}.`);
    const normalized = normalizeWhatsAppPhone(role === "carlos" ? env.STAFF_PHONE_CARLOS : role === "eduardo" ? env.STAFF_PHONE_EDUARDO : null);
    const templateName = options.factibilidadLeadId ? "aviso_factibilidad" : options.caseId ? "aviso_nuevo_pago" : "aviso_nuevo_caso";
    const insert = await env.DB.prepare(`INSERT OR IGNORE INTO staff_notifications_log
      (idempotency_key,role,staff_phone,case_type,customer_name,customer_phone,entity_type,entity_id,source_message_id,
       summary,template_name,template_language,status,ok,attempt_count,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,'es_CL','pending',0,0,datetime('now'),datetime('now'))`)
      .bind(identity.key, role, normalized || null, sanitizeStaffTemplateParam(caseType, 120), sanitizeStaffTemplateParam(customerName, 160) || null,
        normalizeWhatsAppPhone(customerPhone) || null, identity.type, identity.id, options.sourceMessageId || null,
        sanitizeStaffTemplateParam(summary, 300), templateName).run();
    const row = await env.DB.prepare("SELECT * FROM staff_notifications_log WHERE idempotency_key=?").bind(identity.key).first();
    if (!insert.meta?.changes) return { ok: row?.status !== "failed", duplicate: true, status: row?.status };
    const lastAttemptMs = await lastStaffNotificationAttemptMs(env, role);
    if (Date.now() - lastAttemptMs < STAFF_NOTIFICATION_PACING_MS) {
      return { ok: true, status: "queued", queued: true };
    }
    return await deliverStaffNotification(env, credentials, row);
  } catch (error) {
    console.error("staff_notification_failed", role, caseType, String(error?.message || error));
    return { ok: false, status: "failed", error: String(error?.message || error) };
  }
}

// Se llama sin bloquear (ctx.waitUntil) al final de cada webhook de Meta -- despacha como mucho un
// aviso pendiente por rol y solo si ya pasó el espaciado mínimo, para ir vaciando la cola de a poco
// en vez de todos juntos.
async function flushQueuedStaffNotifications(env) {
  await ensureStaffNotificationsLogTable(env);
  const credentials = await getWhatsAppCredentials(env);
  if (!credentials.accessToken || !credentials.phoneNumberId) return { ok: false, error: "Credenciales de WhatsApp incompletas." };
  const results = [];
  for (const role of ["carlos", "eduardo"]) {
    const lastAttemptMs = await lastStaffNotificationAttemptMs(env, role);
    if (Date.now() - lastAttemptMs < STAFF_NOTIFICATION_PACING_MS) continue;
    const pending = await env.DB.prepare(
      "SELECT * FROM staff_notifications_log WHERE role=? AND status='pending' ORDER BY created_at ASC LIMIT 1"
    ).bind(role).first();
    // Auditoría 2026-10-05: 34 avisos a Carlos fallaron con 131042 (problema de pago de Meta) y nunca se
    // reintentaron solos, así que cuando el pago se arreglaba esos casos seguían sin avisarse. Si no hay
    // nada pendiente, se reintenta UN aviso fallido por 131042 de las últimas 24 h (los más viejos ya son
    // ruido), con al menos 30 min entre intentos del mismo aviso para no insistir mientras siga el bloqueo.
    const retry = pending ? null : await env.DB.prepare(`SELECT * FROM staff_notifications_log
      WHERE role = ? AND status = 'failed' AND error_code = '131042' AND created_at > datetime('now', '-24 hours')
      AND (last_attempt_at IS NULL OR last_attempt_at < datetime('now', '-30 minutes'))
      ORDER BY created_at ASC LIMIT 1`).bind(role).first();
    const target = pending || retry;
    if (!target) continue;
    const result = await deliverStaffNotification(env, credentials, target).catch((error) => ({ ok: false, error: String(error?.message || error) }));
    results.push({ role, id: target.id, retried: Boolean(retry), ...result });
  }
  return { ok: true, results };
}

async function updateStaffNotificationStatus(env, item) {
  await ensureStaffNotificationsLogTable(env);
  const row = await env.DB.prepare("SELECT id,status FROM staff_notifications_log WHERE message_id=?").bind(item.messageId).first();
  if (!row) return;
  const next = String(item.status || "").toLowerCase();
  if (!["sent", "delivered", "read", "failed"].includes(next)) return;
  const rank = { pending: 0, accepted: 1, sent: 2, delivered: 3, read: 4 };
  if (next !== "failed" && (rank[next] || 0) < (rank[row.status] || 0)) return;
  const error = staffMetaError({ error: item.error || null });
  await env.DB.prepare(`UPDATE staff_notifications_log SET status=?,ok=?,error_code=?,error_message=?,error_details=?,updated_at=datetime('now') WHERE id=?`)
    .bind(next, next === "failed" ? 0 : 1, next === "failed" ? error.code : null,
      next === "failed" ? error.message : null, next === "failed" ? error.details : null, row.id).run();
}

async function sendBotReply(env, credentials, phone, text, preferAudio) {
  if (preferAudio) {
    const audioBytes = await synthesizeSpeech(env, text).catch(() => null);
    if (audioBytes) {
      const result = await sendWhatsAppAudio(env, credentials, phone, audioBytes).catch(() => null);
      if (result?.ok) return result;
    }
    // Si la síntesis de voz o el envío del audio falla, nunca dejar al cliente sin respuesta:
    // se cae de vuelta a texto en vez de fallar en silencio.
  }
  return sendWhatsAppText(env, credentials, phone, text);
}

async function sendWhatsAppText(env, credentials, phone, text) {
  const endpoint = `https://graph.facebook.com/v25.0/${encodeURIComponent(credentials.phoneNumberId)}/messages`;
  const metaResponse = await fetch(endpoint, {
    method: "POST",
    headers: { authorization: `Bearer ${credentials.accessToken}`, "content-type": "application/json" },
    body: JSON.stringify({ messaging_product: "whatsapp", recipient_type: "individual", to: phone, type: "text", text: { body: text } }),
  });
  const meta = await metaResponse.json().catch(() => ({}));
  const messageId = meta.messages?.[0]?.id;
  if (metaResponse.ok && messageId) {
    await ensureWhatsAppInboxTable(env);
    await env.DB.prepare(`INSERT OR IGNORE INTO whatsapp_inbox_messages
      (message_id, phone, direction, message_type, message_text, created_at, raw_json)
      VALUES (?, ?, 'outbound', 'text', ?, ?, ?)`)
      .bind(messageId, phone, text, new Date().toISOString(), JSON.stringify(meta)).run();
  }
  return { ok: metaResponse.ok, messageId, error: meta.error?.message };
}

// Catálogo de planes por zona para solicitudes de contratación nueva. El bot NUNCA decide a qué
// grupo pertenece un sector -- eso lo fija el cliente al escribirlo y Carlos al confirmar
// factibilidad; el bot solo intenta reconocer nombres de sector ya conocidos (ver matchPlanGroup).
const PLAN_GROUPS = {
  cayucupil: {
    label: "Cayucupil",
    plans: [
      { speed: "100mb/s", price: 18000 },
      { speed: "300mb/s", price: 25000 },
      { speed: "500mb/s", price: 30000 },
    ],
  },
  otros: {
    label: "Peleco, Lanalhue, Trangilboro, Llenquehue",
    plans: [
      { speed: "30mb/s", price: 18000 },
      { speed: "50mb/s", price: 25000 },
    ],
  },
};
const INSTALLATION_COST = 25000;

// Caso real (2026-10-02, +56 9 3763 8489): una clienta preguntó si la instalación "se paga en la
// boleta" y la IA, sin ninguna regla al respecto, le inventó que sí. La política real es que el costo
// de instalación + el mes proporcional se pagan EL DÍA de la instalación, nunca en la boleta.
const INSTALLATION_PAYMENT_POLICY = `📌 Al momento de la instalación se debe pagar el costo de instalación 🔧 ($${INSTALLATION_COST.toLocaleString("es-CL")}), más el valor del servicio del mes por adelantado 📆, el cual se calcula de forma proporcional según los días que resten del mes ⏳.\n\nQuedamos atentos a cualquier consulta.\nBP GO 💻⚡`;

function isInstallationPaymentQuestion(text) {
  const normalized = cyberNormalize(text);
  if (!/\binstala(cion|ciones|r|rme|rse|rlo)?\b/.test(normalized)) return false;
  // Un comprobante o un pago ya hecho es otro flujo (cobranza), no una duda sobre cómo se cobra.
  if (/\b(pague|pagado|pagamos|transferi|transferencia|comprobante|deposite)\b/.test(normalized)) return false;
  return /\b(cuanto (cuesta|sale|vale|es|cobran|pago|pagar|hay que pagar)|costo|cuesta|valor|precio|cobran|cobro|pago|pagar|pagan|paga|boleta)\b/.test(normalized);
}

function matchPlanGroup(sectorText) {
  // Normaliza acentos (Rucañire -> rucanire) para no repetir el bug ya visto con "señal": una ñ
  // sin tilde escrita por el cliente no debe impedir el match.
  const norm = String(sectorText || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
  if (["cayucupil", "los aromos", "la curva", "tres sauces", "fundo anique", "rucanire", "canete"].some((s) => norm.includes(s))) return "cayucupil";
  if (["peleco", "lanalhue", "trangilboro", "llenquehue"].some((s) => norm.includes(s))) return "otros";
  return null;
}

function formatPlansMessage(groupKey) {
  const group = PLAN_GROUPS[groupKey];
  if (!group) return null;
  const lines = group.plans.map((p) => `• ${p.speed} — $${p.price.toLocaleString("es-CL")}/mes`).join("\n");
  return `¡Buenas noticias! Sí tenemos factibilidad en tu sector. 🎉\n\nEstos son los planes disponibles:\n${lines}\n\nCosto de instalación (pago único): $${INSTALLATION_COST.toLocaleString("es-CL")}\n\n¿Cuál plan te gustaría contratar?`;
}

// Caso real (2026-10-01): un mensaje que no calza con ningún plan reenviaba el mismo texto de
// "¡Buenas noticias! Sí tenemos factibilidad..." de nuevo -- si el cliente ya lo había recibido
// segundos antes, se veía (con razón) como que el bot mandó el mismo mensaje dos veces. Este
// recordatorio es más corto y no repite el anuncio de factibilidad, que ya se dijo una vez.
function formatPlanReminderMessage(groupKey) {
  const group = PLAN_GROUPS[groupKey];
  if (!group) return null;
  const lines = group.plans.map((p) => `• ${p.speed} — $${p.price.toLocaleString("es-CL")}/mes`).join("\n");
  return `${PLAN_REMINDER_MARKER}:\n${lines}\n\n¿Cuál plan te gustaría contratar?`;
}
const PLAN_REMINDER_MARKER = "Para continuar, respóndeme con el plan que prefieras";

// Una persona puede pedir "empezar de nuevo" en medio de cualquier conversación del embudo de venta
// (caso real 2026-10-05: el bot quedó "pegado" en la lista de planes y no olvidaba lo hablado).
function isRestartRequest(text) {
  // Frases explícitas a propósito: "reiniciar/reinicio" a secas se usa con el router en el soporte técnico.
  return /\b(empezar de nuevo|comenzar de nuevo|volver a empezar|desde cero|nueva conversacion|reiniciar (la )?conversacion|reinicia (la )?conversacion|olvida (todo|lo que))\b/.test(cyberNormalize(text));
}

// Mismo caso real: la clienta en realidad estaba preguntando algo ("¿debo cancelar en el momento
// que instalen?"), no intentando nombrar un plan -- había que escalarla a un agente, no insistir
// con el mismo mensaje de planes como si no hubiera dicho nada.
function looksLikeQuestion(text) {
  if (/\?/.test(String(text || ""))) return true;
  const normalized = cyberNormalize(text);
  return /^(debo|puedo|necesito saber|que pasa|como|cuando|donde|por que|porque|cuanto|hay que|tengo que)\b/.test(normalized);
}

function matchChosenPlan(groupKey, text) {
  const group = PLAN_GROUPS[groupKey];
  if (!group) return null;
  const normalized = String(text || "").toLowerCase();
  const normalizedNoSep = normalized.replace(/[.,]/g, "");
  // El cliente puede referirse al plan por velocidad ("el de 50mb") o por precio ("el de 25.000" /
  // "25,000" / "25000") -- probamos precio primero porque es menos ambiguo (la velocidad "25" no
  // existe en ningún grupo, pero conviene no depender de eso).
  const byPrice = group.plans.find((p) => normalized.includes(p.price.toLocaleString("es-CL")) || normalizedNoSep.includes(String(p.price)));
  if (byPrice) return byPrice;
  const bySpeedWithUnit = normalizedNoSep.match(/(\d+)\s*mb/);
  if (bySpeedWithUnit) {
    const found = group.plans.find((p) => parseInt(p.speed, 10) === Number(bySpeedWithUnit[1]));
    if (found) return found;
  }
  const anyNumber = normalizedNoSep.match(/(\d+)/);
  if (!anyNumber) return null;
  const bySpeed = group.plans.find((p) => parseInt(p.speed, 10) === Number(anyNumber[1]));
  if (bySpeed) return bySpeed;
  // Caso real (2026-10-06, 56962138241): "El de 25" era el plan de $25.000. Un número chico suelto que no es
  // una velocidad del sector se interpreta como el precio en miles ("el de 25" = $25.000, "el de 18" = $18.000).
  const thousands = Number(anyNumber[1]) * 1000;
  return group.plans.find((p) => p.price === thousands) || null;
}

function planConfirmationMessage(plan) {
  return `¡Excelente decisión! Con el plan ${plan.speed} ($${plan.price.toLocaleString("es-CL")}/mes) puedes realizar todo lo necesario para navegar. 🎉\n\n${INSTALLATION_PAYMENT_POLICY}`;
}

const NO_FACTIBILIDAD_MESSAGE = "Lamentablemente por el momento no contamos con factibilidad técnica en tu sector 😔. Dejamos registrada tu solicitud y, apenas ampliemos cobertura en tu zona, te avisaremos de inmediato. ¡Gracias por tu interés en BPGO! 💙";

const INSTALLATION_DATA_REQUEST_MESSAGE = "Necesito los siguientes datos para realizar la instalación:\n\nNombre del titular:\nRut:\nNúmero de teléfono:\nCorreo:\nDirección:\n\nMe los puedes enviar todos juntos o uno por uno, como te acomode. 🙌";

const INSTALLATION_FIELD_LABELS = { name: "nombre del titular", rut: "RUT", phone: "número de teléfono", email: "correo", address: "dirección" };

// Texto suelto que claramente NO es un dato de instalación (una pregunta del cliente, o una
// confirmación tipo "ahí están los datos"/"gracias") -- se descarta en vez de pegarlo al nombre o
// a la dirección, que es lo que pasaba antes (una pregunta del cliente terminó "anotada" como si
// fuera parte de su nombre).
function isLikelyNotAName(raw) {
  const text = String(raw || "");
  if (/\?/.test(text)) return true;
  const normalized = text.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim();
  if (/\b(verdad|cierto|no es asi)\b/.test(normalized)) return true;
  return /^(gracias|listo|ok|okay|dale|ya|ahi estan|ahi esta|eso es todo|eso seria todo|son esos|esos son|los datos)\b/.test(normalized);
}

// Ninguno de los flujos deterministicos (venta nueva, captura de nombre para visita/pago/
// descuento) tenía forma de que el cliente se bajara a mitad de camino -- cualquier texto se
// trataba como si fuera el dato que se estaba pidiendo. Esto detecta que el cliente cambió de
// opinión, para cerrar el trámite con una respuesta coherente en vez de seguir insistiendo.
function isOptOutMessage(text) {
  const normalized = String(text || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim();
  if (!normalized) return false;
  return /^(ya no( quiero)?|mejor no|no quiero|no gracias|olvidalo|dejalo asi|da lo mismo|no me interesa|ya no importa|cancela eso|no seguir|ya no sigamos|dejemoslo (asi|ahi))\b/.test(normalized)
    || /\b(ya no quiero (seguir|continuar)|no me interesa (ya|mas)|olvida (eso|lo)|mejor lo dejamos|no seguire|prefiero no seguir)\b/.test(normalized);
}

// Algunos clientes no mandan el formulario completo en un solo mensaje, van completando los datos
// de a poco; otros mandan todo junto (a veces copiando línea por línea el mensaje con las
// etiquetas "Nombre:", "Rut:", etc. que les mandamos, o pegando varios datos en un solo bloque).
// Este clasificador corre en CADA mensaje mientras falten datos, procesa línea por línea y
// devuelve TODOS los campos que reconoce en el mensaje (antes solo devolvía uno solo y el resto se
// perdía). RUT/correo/teléfono son fáciles de reconocer por formato; nombre y dirección (ambos
// texto libre) usan una heurística simple (dígitos o palabras típicas de dirección), y el texto que
// no es ninguna de esas cosas ni un dato plausible se descarta en vez de forzarlo a un campo.
function classifyInstallationFragment(text, current) {
  const raw = String(text || "").trim();
  if (!raw) return null;
  const updates = {};
  let addressSoFar = current.address || null;
  let nameSoFar = current.name || null;
  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.replace(/^\s*(nombre( del titular)?|rut|tel[eé]fono|correo|direcci[oó]n)\s*:\s*/i, "").trim();
    if (!line) continue;
    const rutMatch = line.match(/\b\d{1,2}\.?\d{3}\.?\d{3}-[\dkK]\b/);
    if (rutMatch) { updates.rut = rutMatch[0]; continue; }
    const emailMatch = line.match(/[^\s@]+@[^\s@]+\.[^\s@]+/);
    if (emailMatch) { updates.email = emailMatch[0].toLowerCase(); continue; }
    const phoneMatch = line.match(/(?:\+?56)?\s*9\d{8}\b/);
    if (phoneMatch) { updates.phone = phoneMatch[0].trim(); continue; }
    const looksLikeAddress = /\d/.test(line) || /\b(calle|avenida|av\.?|pasaje|camino|sector|km|villa|poblaci[oó]n|parcela|hijuela|block|depto|casa)\b/i.test(line);
    if (looksLikeAddress) {
      addressSoFar = addressSoFar ? `${addressSoFar} ${line}`.trim() : line;
      updates.address = addressSoFar;
      continue;
    }
    if (isLikelyNotAName(line)) continue;
    // Texto libre sin dígitos ni palabras de dirección: mientras no haya aparecido ninguna señal de
    // dirección todavía, se asume que sigue siendo parte del nombre (para no cortar nombres
    // compuestos que el cliente manda palabra por palabra); una vez que la dirección ya empezó, el
    // texto libre que sigue se suma ahí.
    if (!addressSoFar) {
      nameSoFar = nameSoFar ? `${nameSoFar} ${line}`.trim() : line;
      updates.name = nameSoFar;
    } else {
      addressSoFar = `${addressSoFar} ${line}`.trim();
      updates.address = addressSoFar;
    }
  }
  return Object.keys(updates).length ? updates : null;
}

function missingInstallationFields(lead) {
  const fields = [
    ["name", lead.installation_name],
    ["rut", lead.installation_rut],
    ["phone", lead.installation_phone],
    ["email", lead.installation_email],
    ["address", lead.installation_address],
  ];
  return fields.filter(([, value]) => !String(value || "").trim()).map(([field]) => INSTALLATION_FIELD_LABELS[field]);
}

const BOT_SYSTEM_PROMPT = `Eres el asistente de WhatsApp de BPGO, un proveedor de internet/TV cable en Chile. Respondes en español, tono cercano, profesional y chileno neutro. Normalmente usa 1-2 frases y como máximo un emoji cuando aporte.

Reglas duras, nunca las rompas:
- Usa el historial reciente como una conversación continua. Interpreta respuestas cortas (sí, no, ya, listo, correcto, ese, números, fechas o colores) según la última pregunta de BPGO. No vuelvas a pedir nombre, sector, dirección, plan, problema, días sin servicio, reinicio del router ni titular si ya aparecen en el historial o en Cliente identificado.
- Responde directamente. No repitas saludos, despedidas ni lo que el cliente acaba de decir. Nunca uses frases de servicio al cliente genérico/robótico, ni en español ni traducidas del inglés -- prohibido literalmente: "Estoy aquí para ayudarte", "Si tienes más preguntas", "No dudes en contactarnos", "Quedo atento", "¿Podrías aclarar un poco más a qué te refieres?", "¿En qué puedo ayudarte hoy?", "¿Tienes alguna consulta específica o algo en lo que necesites ayuda?", "Parece que hay un malentendido", "Entiendo que estés [molesta/confundida/etc.]. Si quieres discutir alguna inquietud...". Esas frases suenan a bot corporativo, no a una persona real de BPGO escribiendo por WhatsApp. Ejemplo: si el cliente manda una foto o PDF sin decir nada, NO preguntes "¿en qué puedo ayudarte con esto?" (es obvio que es un posible comprobante) -- agradece y sigue el flujo de comprobantes de abajo. Si el cliente está molesto o confundido, no lo valides con una frase de manual ("entiendo tu frustración"); resuelve directo su punto en 1 frase, como lo haría un colega, no un psicólogo. Si de verdad no entendiste el mensaje, pide que lo repita de forma simple y natural ("no te entendí bien, ¿me lo explicas de nuevo?"), sin sonar a plantilla.
- Escribe como una persona real de BPGO conversando por WhatsApp, no como un formulario de atención al cliente: frases cortas y naturales, sin repetir el mismo dato dos veces en un mismo mensaje, y sin cerrar cada respuesta con una pregunta de relleno tipo "¿necesitas algo más?" cuando no aporta nada. Ajusta tu formalidad a la del cliente -- si escribe informal, con errores de tipeo o abreviado, respóndele natural y cercano, no en un registro más formal que el de él. No repitas la misma idea con otras palabras en el mismo mensaje (ej. no digas el saldo o la fecha dos veces seguidas de formas distintas).
- NUNCA confirmes ni marques un pago como "recibido" o "verificado" en el sistema. Una imagen cualquiera NO es un comprobante. Usa "payment_ack" solo si el texto/caption dice explícitamente que pagó/envía comprobante, o si el adjunto muestra claramente un comprobante bancario y puedes enumerar al menos 3 señales reales en receipt_evidence (por ejemplo: título de comprobante, banco, monto, fecha/hora, cuentas, destinatario o número de operación). Una foto de router, perfil, catálogo u otra imagen es general/técnica, nunca pago. Si sí es comprobante, solo agradece y explica que el equipo lo revisará. Nunca inventes monto, fecha ni evidencia.
- Si el cliente pide el link/enlace para pagar, pregunta dónde pagar, cómo pagar online o quiere pagar su plan, responde directamente con el único portal oficial: https://bpgo.cl/pagar. No escales este caso ni inventes otro enlace.
- Si el cliente pregunta cuánto debe, cuándo vence su pago, o el estado de su cuenta: usa EXCLUSIVAMENTE el dato de "Cliente identificado" (saldo/vencimiento) que te doy abajo, con la acción "reply". Nunca inventes un monto o fecha. Si ese dato no está disponible o el cliente no fue identificado, dilo claramente y usa "escalate".
- "billing_review_request" (Descuento por corte) es SOLO para cuando el cliente pide explícitamente el descuento/ajuste, o pregunta directamente cuánto le van a cobrar o descontar por los días sin servicio (ej. "me van a descontar esos días?", "cuánto tengo que pagar si estuve sin internet", "quiero que me hagan un descuento"). Si el cliente SOLO está reportando la falla y respondiendo tu diagnóstico técnico (aunque mencione hace cuántos días o desde qué hora no tiene servicio), eso NO es un pedido de descuento -- sigue el flujo de diagnóstico técnico normal de más abajo, NO uses "billing_review_request" solo porque haya un número de días de por medio. Cuando sí corresponda billing_review_request: NUNCA calcules ni menciones ningún monto, descuento o total ajustado, bajo ninguna circunstancia. Eso solo lo decide un humano. Usa "reply" para preguntar cuántos días exactos estuvo sin servicio si no te lo ha dicho, y cuando lo tengas usa la acción "billing_review_request" con "days_without_service" (número) y un resumen en "reason" — nunca en "text" va un monto.
- En conversaciones de cobranza, interpreta "cancelar", "cancelo", "voy a cancelar" y expresiones equivalentes como PAGAR, que es un uso común en Chile. NO las interpretes como dar de baja el servicio. Solo entiende intención de baja cuando el cliente lo diga explícitamente: "dar de baja", "cancelar el servicio/contrato/plan", "terminar el servicio", "no quiero seguir", etc. Cuando SÍ sea una baja real, usa "escalate" siempre -- nunca la resuelvas tú, nunca confirmes la baja, nunca prometas fecha ni devolución, solo indica que un agente lo va a gestionar.\n- Antes de asumir que palabras como "señal", "mala señal", "sin señal" o "intermitente" se refieren al servicio BPGO, identifica el contexto. Si el cliente habla de su trabajo, faena, minera, campamento, oficina, cobertura móvil o del lugar donde está temporalmente, NO inicies diagnóstico del router ni lo trates como una falla BPGO salvo que diga explícitamente que es el internet BPGO. En Chile "cancelar" también puede significar "pagar": frases como "a la tarde cancelo, está mala la señal donde trabajo" significan que pagará más tarde porque en su trabajo tiene mala conectividad; responde brevemente confirmando que puede hacerlo más tarde y NO hagas preguntas técnicas.\n- Si el cliente reporta una falla técnica (sin internet, lento, intermitente, etc.) y NO pidió una visita ni un descuento todavía, NO uses "visit_request" de inmediato. Haz diagnóstico progresivo y pregunta UNA sola cosa por respuesta, sin repetir lo ya contestado: primero luz del router, luego reinicio por 2 minutos, después si afecta a todos los dispositivos y finalmente desde cuándo comenzó. Para lentitud, comienza preguntando si ocurre en todos los equipos o solo en uno. Sigue así hasta que el cliente confirme que afecta a todos los dispositivos, ya respondió 2-3 preguntas y el problema sigue, o pida explícitamente una visita/técnico. En ese momento usa "visit_request" con un resumen COMPLETO en "reason" -- no una frase corta: incluye todo lo que el cliente contó (color/estado de la luz, si reinició el router y qué pasó, si afecta a todos los dispositivos o solo uno, hace cuánto/desde cuándo, y cualquier otro detalle que haya dado) para que el técnico que llegue a terreno ya sepa qué está pasando sin tener que volver a preguntar (el sistema se encarga por su cuenta de pedir el nombre del titular si hace falta, no necesitas preguntarlo tú). Nunca confirmes un horario exacto, solo di que quedó registrada la solicitud. Este es el flujo normal para "estoy sin internet" -- billing_review_request NUNCA reemplaza este flujo, son cosas distintas (una es mandar un técnico, la otra es un descuento que el cliente pidió aparte).
- Reserva la acción "escalate" solo para: el cliente pide explícitamente hablar con una persona, insulta, hace un reclamo grave, o pregunta algo puntual que no sabes con certeza (fuera de las FAQs y de los datos de cliente dados). Si el mensaje es corto, ambiguo, tiene errores de tipeo, o simplemente no lo entiendes (ej. "hol", una palabra suelta, algo cortado), NUNCA escales por eso solo: usa "reply" y pide amablemente que repita o aclare qué necesita. Escala únicamente si ya pediste aclaración y el cliente sigue sin poder comunicar lo que necesita.
- Si el cliente escribe porque quiere CONTRATAR internet por primera vez (no es cliente ya identificado, o pide un nuevo punto/dirección), usa la acción "new_customer_request" y no digas nada más tú: el sistema se encarga de preguntar el sector, pedir la ubicación, revisar factibilidad con el equipo y mostrar los planes, todo por su cuenta. Esto incluye cuando el cliente responde a un aviso/campaña de zona nueva habilitada (ej. "sí", "qué valores tiene", "quiero agendar") y cuando pregunta por precios o planes SIN estar identificado como cliente -- en ambos casos usa "new_customer_request", NUNCA cotices un plan o precio de memoria ni con las FAQs: los precios dependen del sector exacto (hay más de un tarifario) y solo el flujo determinístico sabe cuál corresponde una vez que el cliente dice su sector.
- Cuando el cliente deja claro que quiere instalarse, conectarse, o retomar/resolver una visita de instalación que quedó pendiente (aunque la situación sea confusa: un cupo, una instalación a medias, alguien de la familia que no estaba), no encadenes varias preguntas parafraseando lo mismo ("¿te refieres a...?", "entiendo que... ¿quieres que...?") en mensajes separados -- quédate con la interpretación más razonable de lo que ya dijo y avanza directo con energía de venta hacia el siguiente paso concreto (qué falta para agendar, qué dato necesitas, confirmar la visita), en vez de sonar administrativo o darle vueltas pidiendo que aclare algo que ya quedó claro.
- NUNCA prometas ni confirmes el día u hora en que llegará un técnico ("mañana", "hoy", "en la mañana", etc.): solo di que la solicitud quedó registrada y que un agente confirmará el horario. NUNCA inventes políticas, plazos o reglas de la empresa (por ejemplo "no se pueden cambiar las fechas de pago", cupos o promociones): si algo no está en las FAQs ni en los datos del cliente, usa "escalate". El campo "text" es siempre el mensaje DIRIGIDO al cliente, nunca una nota sobre él ("el cliente quiere...").
- NUNCA menciones saldo, deuda, monto pendiente, estado de pago ni vencimiento si en el mensaje ACTUAL el cliente no preguntó por pagos o cobranza. Si el cliente reporta una falla de internet o responde una pregunta de identificación (por ejemplo solo su nombre), continúa con SU problema: confirma lo que dijo y sigue el flujo técnico o de visita; no cambies de tema a su cuenta.
- Política de pago de la INSTALACIÓN (única versión válida, nunca la contradigas ni la inventes distinta): el costo de instalación ($25.000) más el mes de servicio por adelantado, calculado proporcional a los días que resten del mes, se pagan AL MOMENTO DE LA INSTALACIÓN. NUNCA se cobran en la boleta ni se difieren al primer mes de servicio. Si el cliente pregunta si la instalación o su costo "se paga en la boleta", responde claramente que NO. Si dudas de cualquier otro detalle de cómo se cobra una instalación, usa "escalate" en vez de inventar.
- Para todo lo demás (preguntas frecuentes, saludos, consultas generales que sí puedes responder con las FAQs dadas), usa la acción "reply".

Debes responder SIEMPRE llamando a la herramienta bpgo_bot_action con una única acción.`;

function formatCurrency(value) {
  if (value === null || value === undefined || String(value).trim() === "") return null;
  const amount = Number(value);
  return Number.isFinite(amount) ? `$${amount.toLocaleString("es-CL")}` : null;
}

const BILLING_REVIEW_REPLY = "Voy a dejar esta consulta para revisión del equipo antes de confirmarte el monto.";

// Un mensaje "habla de plata" solo si menciona pagos, saldo, deuda, boleta, vencimiento o montos. Se usa para
// decidir si la IA puede ver (y por tanto mencionar) los datos de cobranza del cliente.
function mentionsBillingTopic(value) {
  const text = String(value || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/\s+/g, " ");
  return /\b(pag\w*|saldo|deuda|debo|debe|adeud\w*|vence\w*|vencimiento|boleta|factura|cuenta|cobr\w*|monto|mensualidad|cuanto|comprobante|transfer\w*|deposit\w*|cancel\w*)\b/.test(text);
}

function isBalanceQuestion(value) {
  const text = String(value || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/\s+/g, " ");
  return /\b(saldo|deuda|estado de (mi )?cuenta|cuanto (debo|pago|tengo que pagar)|que tengo que pagar)\b/.test(text);
}

function authoritativeBalanceAction(customer) {
  if (!customer?.id || !customer.billingAuthoritative || customer.billingAmbiguous) {
    return { action: "escalate", text: BILLING_REVIEW_REPLY, reason: "billing_balance_not_authoritative" };
  }
  const amount = customer.balance;
  const status = String(customer.paymentStatus || "").trim();
  if (!Number.isFinite(amount) || amount < 0 || !status) {
    return { action: "escalate", text: BILLING_REVIEW_REPLY, reason: "billing_balance_missing_or_ambiguous" };
  }
  if (amount === 0) {
    if (!/^(pagado|sin deuda|al d[ií]a)$/i.test(status)) {
      return { action: "escalate", text: BILLING_REVIEW_REPLY, reason: "billing_zero_not_confirmed" };
    }
    return { action: "reply", text: "Tu registro vigente figura pagado y sin deuda pendiente." };
  }
  if (!/^(pendiente|vencido|suspendido)$/i.test(status)) {
    return { action: "escalate", text: BILLING_REVIEW_REPLY, reason: "billing_status_inconsistent" };
  }
  return { action: "reply", text: `Tu saldo pendiente registrado es de ${formatCurrency(amount)}.` };
}

const PAYMENT_PORTAL_REPLY = "Puedes pagar tu mensualidad acá:\nhttps://bpgo.cl/pagar";
const PAYMENT_TRANSFER_REPLY = "Si el link de pago no te funciona, puedes pagar por transferencia o CajaVecina con estos datos:\nBanco Estado\nCuenta corriente\nBP GO\nRUT 77.463.597-1\nN° de cuenta 39100126196\nCorreo: consultorabpconnection@gmail.com\n\nCuando realices el pago, envíanos el comprobante por este medio.";

function isAlternativePaymentRequest(value) {
  const text = String(value || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/\s+/g, " ").trim();
  const linkProblem = /\b(link|enlace|pagina|portal)\b/.test(text) && /\b(no funciona|no me funciona|no puedo|no carga|error|problema|complica|complicado)\b/.test(text);
  const asksAlternative = /\b(otra forma|otra opcion|alternativa)\b.{0,30}\b(pago|pagar)\b/.test(text)
    || /\b(transferencia|transferir|caja ?vecina|datos bancarios|datos para pagar|numero de cuenta|cuenta bancaria|cuenta para depositar|depositar|deposito)\b/.test(text)
    || /\b(cuenta|datos)\b.{0,35}\b(depositar|transferir|pagar)\b/.test(text)
    // cubre ambos órdenes naturales en español: "cuenta sigue siendo la misma" y "tiene la misma cuenta".
    || /\b(cuenta|datos)\b.{0,45}\b(sigue|siguen|misma|mismos)\b/.test(text)
    || /\b(sigue|siguen|misma|mismos)\b.{0,45}\b(cuenta|datos)\b/.test(text);
  return linkProblem || asksAlternative;
}

function isPaymentLinkRequest(value) {
  const text = String(value || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/\s+/g, " ").trim();
  return /\b(link|enlace)\b.{0,40}\b(pago|pagar)\b/.test(text)
    || /\b(donde|como)\s+(?:puedo\s+)?(?:pago|pagar)\b/.test(text)
    || /\bpagar\s+(?:el|mi|la)?\s*(?:plan|mensualidad)\b/.test(text);
}

function briefCourtesyReply(value) {
  const text = String(value || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z\s]/g, " ").replace(/\s+/g, " ").trim();
  return /^(gracias|muchas gracias|vale gracias|ok gracias)$/.test(text) ? "De nada 👍" : null;
}

function externalConnectivityPaymentReply(value) {
  const text = String(value || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/\s+/g, " ").trim();
  const mentionsLaterPayment = /\b(a la tarde|mas tarde|en la tarde|despues)\b/.test(text)
    && /\b(cancelo|cancelar|pago|pagar|transfiero|transferir)\b/.test(text);
  const mentionsExternalSignal = /\b(mala senal|sin senal|poca senal|senal mala|mala conexion|poca cobertura)\b/.test(text)
    && /\b(trabajo|faena|minera|campamento|oficina|donde trabajo|aca donde trabajo)\b/.test(text);
  if (mentionsLaterPayment && (mentionsExternalSignal || /\b(senal|conexion|cobertura)\b/.test(text))) {
    return "Entendido, puedes realizar el pago más tarde cuando tengas mejor conexión.";
  }
  return null;
}

function cancellationMeansPayment(value, history) {
  const normalize = (input) => String(input || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/\s+/g, " ").trim();
  const text = normalize(value);
  if (!/\b(cancelar|cancelo|cancela|cancele|cancelare|cancelarlo|cancelo)\b/.test(text)) return false;
  // "Cancelar" en Chile se usa habitualmente como "pagar". Solo se interpreta como baja cuando el
  // cliente lo dice de forma explícita respecto del servicio/contrato.
  if (/\b(dar de baja|baja del servicio|cancelar (?:el )?(?:servicio|contrato|internet|plan)|terminar (?:el )?(?:servicio|contrato|plan)|no quiero seguir|quiero retirarme)\b/.test(text)) return false;
  const recent = (Array.isArray(history) ? history : []).slice(-8).map((item) => normalize(item.message_text)).join(" ");
  const billingContext = /\b(mensualidad|pendiente de pago|regularizar|bpgo\.cl\/pagar|pago|pagar|comprobante|deuda|saldo)\b/.test(recent);
  const paymentPhrase = /\b(voy a cancelar|voy a cancelo|voy a cancels|mas tarde cancel|otro ratito.*cancel|a la tarde.*cancel|en la tarde.*cancel)\b/.test(text);
  return billingContext || paymentPhrase || text === "cancelar" || text === "cancelo";
}

function isPaidQuickReply(value) {
  const text = String(value || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[.,!\u00a1\u00bf?]/g, "").trim();
  if (text === "ya pague") return true;
  // Declaraciones expl\u00edcitas de pago ya hecho ("pagu\u00e9", "pago ingresado/realizado", "hice el
  // pago"). No incluye "pago" suelto para no confundirlo con preguntas ("cu\u00e1nto pago", "c\u00f3mo pago").
  return /\bpague\b/.test(text)
    || /\bpago\s+(ya\s+)?(esta\s+)?(ingresado|realizado|hecho|efectuado|enviado|listo)\b/.test(text)
    || /\b(hice|realice|efectue|ingrese)\s+(el\s+)?pago\b/.test(text)
    || /\bya\s+(transferi|deposite)\b/.test(text);
}

function isExecutiveQuickReply(value) {
  const text = String(value || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim();
  return text === "hablar con ejecutivo";
}

async function callBotResponder(env, context, inboundMessage, media) {
  if (isAlternativePaymentRequest(inboundMessage?.text)) return { action: "reply", text: PAYMENT_TRANSFER_REPLY };
  if (isPaymentLinkRequest(inboundMessage?.text)) return { action: "reply", text: PAYMENT_PORTAL_REPLY };
  if (isPaidQuickReply(inboundMessage?.text)) return { action: "reply", text: context.hasPendingReceipt
    ? "Tu comprobante ya está en revisión."
    : "Perfecto. Envíame el comprobante para dejarlo en revisión." };
  if (isExecutiveQuickReply(inboundMessage?.text)) return { action: "escalate", text: "Te comunico con un ejecutivo de BP GO.", reason: "billing_customer_requested_human" };
  if (isBalanceQuestion(inboundMessage?.text)) return authoritativeBalanceAction(context.customer);
  const courtesy = briefCourtesyReply(inboundMessage?.text);
  if (courtesy) return { action: "reply", text: courtesy };
  // Un saludo suelto recibía de la IA "¿En qué puedo ayudar hoy?", justo la frase robótica que el propio prompt prohíbe.
  if (isPureGreeting(inboundMessage?.text)) return { action: "reply", text: "¡Hola! 😊 Cuéntame, ¿qué necesitas?" };
  const externalPayment = externalConnectivityPaymentReply(inboundMessage?.text);
  if (externalPayment) return { action: "reply", text: externalPayment };
  if (cancellationMeansPayment(inboundMessage?.text, context.history)) {
    return { action: "reply", text: "Entendido, puedes realizar el pago más tarde. Cuando lo hagas, si quieres puedes enviarnos el comprobante por este medio." };
  }
  if (!env.OPENAI_API_KEY) return { action: "escalate", reason: "bot_not_configured" };
  let customerLine = "No se pudo identificar al cliente en el sistema por su número.";
  if (context.customer?.name) {
    const balanceText = formatCurrency(context.customer.balance);
    // Caso real (2026-10-05, 56942968352): un cliente sin internet respondió solo su nombre ("Rodrigo pavez")
    // a la pregunta de un agente y el bot contestó "El saldo registrado en tu cuenta es de $18.000, estado
    // pendiente" -- nadie había preguntado por plata. Los datos de cobranza solo se le muestran a la IA cuando
    // el mensaje actual habla de pagos; si no, no están disponibles para mencionarlos.
    const billingTopic = mentionsBillingTopic(inboundMessage?.text);
    const details = [
      context.customer.address ? `dirección ${context.customer.address}` : null,
      !billingTopic ? "datos de cobranza omitidos: el cliente no consultó por pagos, NO menciones saldo, deuda ni estado de pago"
        : context.customer.billingAuthoritative && balanceText ? `saldo registrado ${balanceText}` : "saldo no disponible para confirmación automática",
      billingTopic && context.customer.paymentStatus ? `estado ${context.customer.paymentStatus}` : null,
      // dueDate en los registros de facturación suele quedar fijo desde la contratación y no se
      // actualiza mes a mes (mismo valor en julio/agosto/septiembre) -- mostrarlo cuando ya pasó
      // hace que el bot le diga al cliente una fecha de vencimiento vieja como si fuera vigente.
      billingTopic && context.customer.dueDate && Date.parse(context.customer.dueDate) >= Date.now() ? `vencimiento ${context.customer.dueDate}` : null,
    ].filter(Boolean).join(", ");
    customerLine = `Cliente identificado: ${context.customer.name} (${details}).`;
  }
  const historyLines = context.history
    .map((item) => `${item.direction === "inbound" ? "Cliente" : "BPGO"}: ${item.message_text || `[${item.message_type}]`}`)
    .join("\n");
  const userContent = [];
  let mediaNote = "";
  // Los comprobantes en PDF (bancos, Webpay) también se leen: OpenAI acepta PDF como entrada "file". Si el
  // modelo configurado no lo soporta o el PDF es muy grande, se reintenta sin el PDF (ver más abajo) en vez
  // de dejar al cliente sin respuesta.
  const isPdf = Boolean(media && /pdf/i.test(media.mimeType)) && media.base64.length <= 12 * 1024 * 1024;
  if (media && media.mimeType.startsWith("image/")) {
    userContent.push({ type: "image_url", image_url: { url: `data:${media.mimeType};base64,${media.base64}` } });
  } else if (isPdf) {
    userContent.push({ type: "file", file: { filename: "comprobante.pdf", file_data: `data:application/pdf;base64,${media.base64}` } });
  } else if (media) {
    mediaNote = "\n\n(El cliente adjuntó un documento que no se puede visualizar aquí. NO asumas que es comprobante; solo trátalo como pago si el texto/caption lo indica explícitamente.)";
  }
  const textPart = {
    type: "text",
    text: `FAQs de BPGO:\n${context.faq}\n\n${customerLine}\n\nÚltimos mensajes de la conversación:\n${historyLines || "(sin historial previo)"}\n\nNuevo mensaje del cliente (${inboundMessage.type}): ${inboundMessage.text || "(sin texto, ver adjunto)"}${mediaNote}`,
  };
  const pdfFallbackNote = "\n\n(El cliente adjuntó un documento que no se puede visualizar aquí. NO asumas que es comprobante; solo trátalo como pago si el texto/caption lo indica explícitamente.)";
  userContent.push(textPart);

  const callOpenAi = (content) => fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${env.OPENAI_API_KEY}`,
    },
    // Auditoría: sin timeout, una IA colgada dejaba la tarea del webhook esperando y al cliente sin
    // respuesta; con timeout cae a "bot_api_error" (escalar a un humano), igual que cualquier otro fallo.
    signal: AbortSignal.timeout(25000),
    body: JSON.stringify({
      model: String(env.OPENAI_MODEL || "gpt-4o-mini"),
      max_tokens: 600,
      messages: [
        { role: "system", content: BOT_SYSTEM_PROMPT },
        { role: "user", content },
      ],
      tools: [{
        type: "function",
        function: {
          name: "bpgo_bot_action",
          description: "Acción que el bot de WhatsApp debe ejecutar en respuesta al mensaje del cliente.",
          parameters: {
            type: "object",
            properties: {
              action: { type: "string", enum: ["reply", "payment_ack", "visit_request", "billing_review_request", "escalate", "new_customer_request"] },
              text: { type: "string", description: "Texto a enviar al cliente por WhatsApp (no aplica para escalate). Nunca debe incluir un monto de dinero cuando la acción es billing_review_request." },
              preferred_date: { type: "string", description: "Fecha u horario preferido que dio el cliente para la visita, si aplica." },
              reason: { type: "string", description: "Motivo de la visita/incidencia/revisión de cobro o de la escalación." },
              extracted_amount: { type: "number", description: "Monto pagado, solo si se lee con certeza en la imagen del comprobante (payment_ack)." },
              extracted_date: { type: "string", description: "Fecha del pago, solo si se lee con certeza en la imagen del comprobante (payment_ack)." },
              transaction_id: { type: "string", description: "Número de operación/transacción/folio del comprobante, solo si se lee con certeza (payment_ack). Sirve para detectar comprobantes repetidos." },
              receipt_evidence: { type: "array", items: { type: "string", enum: ["receipt_title", "bank", "amount", "date_time", "origin_account", "destination_account", "recipient", "transaction_id"] }, description: "Señales visibles reales del comprobante. Mínimo 3 para payment_ack sin texto explícito." },
              days_without_service: { type: "number", description: "Cantidad de días que el cliente dijo haber estado sin servicio (billing_review_request)." },
            },
            required: ["action"],
          },
        },
      }],
      tool_choice: { type: "function", function: { name: "bpgo_bot_action" } },
    }),
  }).catch(() => null);
  let response = await callOpenAi(userContent);
  let pdfUnread = false;
  if ((!response || !response.ok) && isPdf) {
    pdfUnread = true;
    // El modelo configurado puede no aceptar PDF: se reintenta sin el archivo, con la nota de "documento
    // no visible", que es el comportamiento anterior (nunca peor que antes).
    response = await callOpenAi([{ ...textPart, text: `${textPart.text}${pdfFallbackNote}` }]);
  }
  if (!response || !response.ok) return { action: "escalate", reason: "bot_api_error" };
  const payload = await response.json().catch(() => null);
  const toolCall = payload?.choices?.[0]?.message?.tool_calls?.[0];
  if (!toolCall?.function?.arguments) return { action: "escalate", reason: "bot_parse_error" };
  const parsed = (() => { try { return JSON.parse(toolCall.function.arguments); } catch { return null; } })();
  if (!parsed?.action) return { action: "escalate", reason: "bot_parse_error" };
  // Si el PDF no se pudo leer, ninguna "evidencia" del comprobante puede ser real: se descarta.
  if (pdfUnread) { parsed.receipt_evidence = []; parsed.extracted_amount = undefined; parsed.transaction_id = undefined; }
  return parsed;
}

const SPANISH_MONTH_NAMES = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];

function currentBillingMonthEs() {
  // new Date().getMonth() usa el reloj del runtime de Cloudflare Workers, que es UTC. Chile va
  // atrasado respecto a UTC, así que en las últimas horas de cada día (y sobre todo a fin de mes)
  // UTC ya muestra el mes siguiente mientras en Chile sigue el mes vigente -- eso hacía que un pago
  // confirmado a esa hora se buscara/aplicara contra el mes equivocado. Se usa chileDateParts() en
  // vez del reloj local del runtime.
  return SPANISH_MONTH_NAMES[chileDateParts().month - 1];
}

// Aplica un pago confirmado por un humano (Carlos/Eduardo tocando el botón de WhatsApp) directamente
// en la facturación real. Solo se llama tras confirmación humana explícita -- nunca desde el bot --
// y solo si hay exactamente un registro de cobranza candidato, para no adivinar a cuál mes/servicio
// corresponde el pago cuando hay ambigüedad.
async function applyPaymentToBillingRecord(env, phone, extractedAmount, attempt = 0) {
  const row = await env.DB.prepare("SELECT data, updated_at FROM app_state WHERE id = 'main'").first();
  const state = row ? JSON.parse(row.data) : null;
  if (!state || !Array.isArray(state.billingRecords)) return { ok: false, reason: "no_state" };
  const pending = state.billingRecords.filter((record) => normalizeWhatsAppPhone(record.phone) === phone && record.status === "Pendiente");
  if (!pending.length) return { ok: false, reason: "no_pending_record" };
  let target = pending.length === 1 ? pending[0] : pending.find((record) => record.billingMonth === currentBillingMonthEs());
  if (!target && Number.isFinite(Number(extractedAmount))) {
    target = pending.find((record) => Number(record.amount) === Math.round(Number(extractedAmount)));
  }
  if (!target) return { ok: false, reason: "ambiguous_record", candidates: pending.length };
  target.status = "Pagado";
  target.followUpStatus = "Pago confirmado";
  // El reloj del Worker es UTC: sin timeZone la nota quedaba con la hora UTC como si fuera hora de Chile.
  target.notes = `Pago confirmado por el equipo BPGO vía WhatsApp el ${new Date().toLocaleString("es-CL", { timeZone: "America/Santiago" })}.`;
  target.lastMessageAt = new Date().toISOString();
  // Se reescribe TODO el estado de la app (un solo JSON): si alguien guardó desde el panel entre la lectura y
  // esta escritura, el UPDATE a ciegas le pisaba sus cambios. Ahora solo escribe si nadie lo tocó (misma
  // updated_at) y, si hubo un cambio en medio, relee y reaplica (hasta 3 veces) en vez de pisarlo.
  const written = await env.DB.prepare("UPDATE app_state SET data = ?, updated_at = datetime('now') WHERE id = 'main' AND updated_at IS ?")
    .bind(JSON.stringify(state), row.updated_at ?? null).run();
  if (!written.meta?.changes) {
    if (attempt >= 2) return { ok: false, reason: "state_conflict" };
    return applyPaymentToBillingRecord(env, phone, extractedAmount, attempt + 1);
  }
  return { ok: true, record: target };
}

async function getKnownAccountName(env, phone) {
  await ensureWhatsAppBotTables(env);
  await ensureWhatsAppAutomationTable(env);
  const visit = await env.DB.prepare(`SELECT reported_name, created_at FROM whatsapp_visit_requests
    WHERE phone = ? AND reported_name IS NOT NULL ORDER BY created_at DESC LIMIT 1`).bind(phone).first();
  const payment = await env.DB.prepare(`SELECT reported_name, created_at FROM whatsapp_automation_cases
    WHERE phone = ? AND reported_name IS NOT NULL ORDER BY created_at DESC LIMIT 1`).bind(phone).first();
  const billing = await env.DB.prepare(`SELECT reported_name, created_at FROM whatsapp_billing_requests
    WHERE phone = ? AND reported_name IS NOT NULL ORDER BY created_at DESC LIMIT 1`).bind(phone).first();
  const candidates = [visit, payment, billing].filter(Boolean).sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  return candidates[0]?.reported_name || null;
  // Nota: reported_name solo se llena en el flujo determinístico (el cliente respondiendo
  // directamente a nuestra pregunta fija), nunca a partir de un campo libre del modelo --
  // por eso es seguro reutilizarlo para no volver a preguntar a un contacto ya identificado.
}

function mentionsServiceOutage(text) {
  return /sin internet|sin servicio|sin conexi[oó]n|d[ií]as? sin|corte de (servicio|internet)/i.test(text || "");
}

function mentionsTechnicalIssueOrVisit(text) {
  return /\b(sin internet|sin conexi[oó]n|no tengo internet|no funciona|falla|corte|fibra|router|luz roja|intermitente|lento|visita|t[eé]cnico|revisi[oó]n)\b/i.test(text || "");
}

async function executeBotAction(env, credentials, phone, action, message) {
  const preferAudio = Boolean(message.preferAudio);
  const textProblem = action.text ? botTextProblem(action.text) : null;
  if (textProblem) {
    console.error("bot_text_blocked", textProblem);
    action = action.action === "reply" ? { action: "escalate", reason: `bot_text_blocked_${textProblem}` } : { ...action, text: undefined };
  }
  if (action.action === "reply" && action.text) {
    // Nunca dejar que el bot mencione un monto/descuento cuando el cliente habla de días sin
    // servicio, aunque el modelo lo intente: se reemplaza por la pregunta segura de días sin
    // servicio en vez de confiar en que el prompt alcance para evitarlo siempre.
    const mentionsOutage = mentionsServiceOutage(message.customerText);
    const mentionsMoney = /\$\s?\d|\b\d{3,}\s*(pesos|clp)\b/i.test(action.text);
    if (mentionsOutage && mentionsMoney) {
      await sendBotReply(env, credentials, phone, "Para revisar el descuento por los días sin servicio, ¿cuántos días exactos estuviste sin internet?", preferAudio);
      return;
    }
    await sendBotReply(env, credentials, phone, action.text, preferAudio);
    return;
  }
  if (action.action === "payment_ack") {
    await ensureWhatsAppAutomationTable(env);
    const caseRow = message.messageId ? await env.DB.prepare(
      "SELECT id, reported_name FROM whatsapp_automation_cases WHERE source_message_id = ?"
    ).bind(message.messageId).first() : null;
    if (!hasStrongReceiptEvidence(action, message)) {
      if (caseRow) {
        await env.DB.prepare(`UPDATE whatsapp_automation_cases SET case_type='general', confidence=35,
          summary='Imagen o documento recibido sin evidencia suficiente de pago.', amount=NULL, service_month=NULL,
          updated_at=datetime('now') WHERE id=?`).bind(caseRow.id).run();
      }
      // El modelo puede llamar "payment_ack" para un mensaje sin ningún adjunto (ej. "el pago está
      // hecho" sin comprobante). El texto fijo decía "Recibí la imagen" sin importar si en verdad
      // llegó una -- eso hacía que el bot afirmara haber recibido algo que el cliente nunca mandó.
      const fallbackReply = message.mediaId
        ? "Recibí tu imagen, pero no logro confirmar que sea un comprobante de pago. Si lo es, cuéntame y lo dejo en revisión."
        : "¿Ya realizaste el pago? Envíame el comprobante para dejarlo en revisión.";
      await sendBotReply(env, credentials, phone, fallbackReply, preferAudio);
      return;
    }
    if (caseRow) {
      await env.DB.prepare(`UPDATE whatsapp_automation_cases SET case_type='payment', confidence=96,
        summary='Comprobante de pago recibido para validación.', updated_at=datetime('now') WHERE id=?`).bind(caseRow.id).run();
    }
    if (caseRow && (Number.isFinite(Number(action.extracted_amount)) || action.extracted_date)) {
      await env.DB.prepare(`UPDATE whatsapp_automation_cases SET
        amount = COALESCE(?, amount), service_month = COALESCE(?, service_month), updated_at = datetime('now')
        WHERE id = ?`)
        .bind(Number.isFinite(Number(action.extracted_amount)) ? Math.round(Number(action.extracted_amount)) : null,
          action.extracted_date || null, caseRow.id).run();
    }
    const receiptCheck = await buildReceiptCheck(env, phone, action, caseRow?.id || null).catch(() => "");
    if (caseRow && receiptCheck) {
      await env.DB.prepare("UPDATE whatsapp_automation_cases SET summary = ? WHERE id = ?")
        .bind(`Comprobante de pago recibido para validación. Verificación: ${receiptCheck}`, caseRow.id).run().catch(() => null);
    }
    const matchedCustomer = await findCustomerForWhatsApp(env, phone, message.customerName);
    // A diferencia del flujo donde el cliente escribe el nombre (que sí pasa por
    // isPlausibleAccountName), este "known" puede venir del nombre registrado en la planilla o de
    // un reported_name ya guardado en un caso anterior. Si esa fuente tiene un dato sucio (fila mal
    // cargada, o un valor inválido que se coló antes por este mismo camino), no se debe reutilizar
    // ni propagar -- se revalida igual antes de confiar en él.
    const rawKnown = caseRow?.reported_name || await getKnownAccountName(env, phone)
      || (matchedCustomer.matchedByPhone ? matchedCustomer.name : null);
    const known = isPlausibleAccountName(rawKnown) ? rawKnown : null;
    if (known) {
      if (caseRow && !caseRow.reported_name) {
        await env.DB.prepare("UPDATE whatsapp_automation_cases SET reported_name = ? WHERE id = ?").bind(known, caseRow.id).run();
      }
      await sendBotReply(env, credentials, phone, action.text || "Recibimos tu comprobante, en breve lo revisamos. ¡Gracias! 🙏", preferAudio);
      await notifyStaff(env, credentials, "carlos", "Comprobante de pago", known, phone, `Comprobante recibido. ${receiptCheck}`.trim(), { caseId: caseRow?.id || null, sourceMessageId: message.messageId });
      await setBotSessionMode(env, phone, "human", "case_created_payment");
      return;
    }
    if (caseRow) {
      await ensureWhatsAppBotTables(env);
      await env.DB.prepare(`INSERT INTO whatsapp_pending_payments (phone, case_id, created_at) VALUES (?, ?, datetime('now'))
        ON CONFLICT(phone) DO UPDATE SET case_id = excluded.case_id, created_at = datetime('now')`)
        .bind(phone, caseRow.id).run();
    }
    await sendBotReply(env, credentials, phone, "¡Gracias por tu comprobante! Para dejarlo asociado a tu cuenta, ¿a nombre de quién está contratado el servicio?", preferAudio);
    return;
  }
  if (action.action === "visit_request") {
    // Mismo principio que billing_review_request: no confiar ciegamente en que el modelo clasificó
    // bien. Si ni el mensaje del cliente ni el resumen del modelo mencionan una falla técnica o un
    // pedido de visita/técnico, no se crea la solicitud -- se pide aclaración en su lugar.
    if (!mentionsTechnicalIssueOrVisit(message.customerText) && !mentionsTechnicalIssueOrVisit(action.reason)) {
      await sendBotReply(env, credentials, phone, "No logré entender bien tu consulta, ¿me la puedes contar de nuevo con más detalle?", preferAudio);
      return;
    }
    // El nombre del titular SIEMPRE se pide y se captura por código en el próximo mensaje si
    // no lo conocíamos ya (ver whatsapp_pending_visits en runBotForInboundMessages) -- nunca se
    // confía en que el modelo lo haya preguntado o lo recuerde, para que esto sea predecible.
    await ensureWhatsAppBotTables(env);
    const matchedCustomer = await findCustomerForWhatsApp(env, phone, message.customerName);
    const known = await getKnownAccountName(env, phone) || (matchedCustomer.matchedByPhone ? matchedCustomer.name : null);
    if (!known && !matchedCustomer.matchedByPhone) {
      // Un teléfono que no corresponde a ningún cliente registrado pidiendo una "visita técnica"
      // casi siempre es en realidad un prospecto nuevo que el modelo clasificó mal (ej. alguien que
      // respondió a un aviso de zona nueva habilitada y quiere agendar la INSTALACIÓN, no reparar un
      // servicio que nunca ha tenido). Preguntarle "¿a nombre de quién está contratado el servicio?"
      // no tiene sentido ahí -- se redirige al flujo de contratación nueva (pregunta el sector).
      await env.DB.prepare(`INSERT INTO whatsapp_sales_leads (id, phone, customer_name, status, created_at, updated_at)
        VALUES (?, ?, ?, 'awaiting_sector', datetime('now'), datetime('now'))`).bind(crypto.randomUUID(), phone, message.customerName || null).run();
      await sendBotReply(env, credentials, phone, "¡Para agendar tu instalación nueva, cuéntanos primero! ¿De qué sector nos escribes?", preferAudio);
      return;
    }
    if (known) {
      const customer = matchedCustomer;
      const transcript = await buildRecentTranscript(env, phone);
      const visitRow = await env.DB.prepare(`INSERT INTO whatsapp_visit_requests (phone, customer_id, customer_name, reported_name, preferred_date, reason, status, created_at, transcript)
        VALUES (?, ?, ?, ?, ?, ?, 'pending', datetime('now'), ?) RETURNING id`)
        .bind(phone, customer.id, customer.name, known, action.preferred_date || null, action.reason || null, transcript).first();
      await sendBotReply(env, credentials, phone, action.text || "Registramos tu solicitud de visita técnica, un agente te confirmará el horario. 🙌", preferAudio);
      await notifyStaff(env, credentials, "eduardo", "Incidencia técnica", known, phone, action.reason || "Cliente reportó una falla técnica.", { visitRequestId: visitRow?.id, sourceMessageId: message.messageId });
      await setBotSessionMode(env, phone, "human", "case_created_visit");
      return;
    }
    await env.DB.prepare(`INSERT INTO whatsapp_pending_visits (phone, reason, preferred_date, created_at)
      VALUES (?, ?, ?, datetime('now'))
      ON CONFLICT(phone) DO UPDATE SET reason = excluded.reason, preferred_date = excluded.preferred_date, created_at = datetime('now')`)
      .bind(phone, action.reason || null, action.preferred_date || null).run();
    await sendBotReply(env, credentials, phone, "Para registrar la visita, ¿a nombre de quién está contratado el servicio?", preferAudio);
    return;
  }
  if (action.action === "billing_review_request") {
    // El modelo puede clasificar mal un mensaje sin ninguna relación con un corte de servicio (se
    // vio en vivo: "Tiene 2 cuentas diferentes" -- sobre el comprobante de pago -- disparó esta
    // acción) como si fuera un pedido de descuento por días sin servicio. No se crea el caso de
    // descuento salvo que el propio mensaje del cliente O el resumen que dio el modelo mencionen
    // explícitamente una falla/corte -- así no se depende solo de que el modelo acierte siempre.
    if (!mentionsServiceOutage(message.customerText) && !mentionsServiceOutage(action.reason)) {
      await sendBotReply(env, credentials, phone, "No logré entender bien tu consulta, ¿me la puedes contar de nuevo con más detalle?", preferAudio);
      return;
    }
    // Igual que en pagos: el bot NUNCA calcula ni menciona un monto de descuento, solo junta
    // los días sin servicio y el nombre del titular para que un humano calcule el ajuste.
    await ensureWhatsAppBotTables(env);
    const days = Number.isFinite(Number(action.days_without_service)) ? Math.round(Number(action.days_without_service)) : null;
    const matchedCustomer = await findCustomerForWhatsApp(env, phone, message.customerName);
    const known = await getKnownAccountName(env, phone) || (matchedCustomer.matchedByPhone ? matchedCustomer.name : null);
    if (known) {
      const customer = matchedCustomer;
      const transcript = await buildRecentTranscript(env, phone);
      const billingRow = await env.DB.prepare(`INSERT INTO whatsapp_billing_requests (phone, customer_id, customer_name, reported_name, days_without_service, reason, status, created_at, transcript)
        VALUES (?, ?, ?, ?, ?, ?, 'pending', datetime('now'), ?) RETURNING id`)
        .bind(phone, customer.id, customer.name, known, days, action.reason || null, transcript).first();
      await sendBotReply(env, credentials, phone, "Registramos tu solicitud de revisión por los días sin servicio. Un agente calculará el ajuste correspondiente y te confirmará. 🙏", preferAudio);
      await notifyStaff(env, credentials, "carlos", "Descuento por corte", known, phone, days ? `${days} día(s) sin servicio. ${action.reason || ""}` : (action.reason || "Cliente pide revisión por corte de servicio."), { billingRequestId: billingRow?.id, sourceMessageId: message.messageId });
      await setBotSessionMode(env, phone, "human", "case_created_billing");
      return;
    }
    await env.DB.prepare(`INSERT INTO whatsapp_pending_billing (phone, days_without_service, reason, created_at)
      VALUES (?, ?, ?, datetime('now'))
      ON CONFLICT(phone) DO UPDATE SET days_without_service = excluded.days_without_service, reason = excluded.reason, created_at = datetime('now')`)
      .bind(phone, days, action.reason || null).run();
    await sendBotReply(env, credentials, phone, "Para registrar la revisión, ¿a nombre de quién está contratado el servicio?", preferAudio);
    return;
  }
  if (action.action === "escalate") {
    await setBotSessionMode(env, phone, "human", action.reason || "bot_escalated");
    // Siempre el texto fijo: la IA a veces rellena `text` con su nota interna sobre el cliente (tercera persona).
    await sendBotReply(env, credentials, phone, "Ya te comunico con un agente de BPGO, en breve te responde por acá. 🙌", preferAudio);
    const escalatedName = await getKnownAccountName(env, phone);
    await notifyStaff(env, credentials, "carlos", "Conversación escalada", escalatedName, phone, action.reason || "El bot no pudo resolver la consulta.", { sourceMessageId: message.messageId });
    return;
  }
  if (action.action === "new_customer_request") {
    // Todo el flujo de contratación (sector, ubicación, factibilidad, planes) es determinístico
    // desde acá en adelante -- nunca se vuelve a llamar al modelo mientras haya una solicitud
    // en curso (ver el chequeo de whatsapp_sales_leads en runBotForInboundMessages).
    await ensureWhatsAppBotTables(env);
    const install = await findScheduledInstallation(env, phone).catch(() => null);
    if (install?.plannedDate) {
      await sendBotReply(env, credentials, phone,
        `¡Hola! 😊 Tu instalación ya está programada para ${describeInstallDate(install.plannedDate, install.today)}. El técnico se pondrá en contacto contigo durante el día. Si necesitas cambiar algo, escríbenos por acá. 🙌`, preferAudio);
      return;
    }
    if (install?.knownCustomer) {
      await setBotSessionMode(env, phone, "human", "bot_escalated");
      await sendBotReply(env, credentials, phone, "Ya te comunico con un agente de BPGO, en breve te responde por acá. 🙌", preferAudio);
      await notifyStaff(env, credentials, "carlos", "Conversación escalada", await getKnownAccountName(env, phone), phone,
        `Cliente ya registrado consulta por contratación/visita: "${String(message.customerText || "").slice(0, 150)}"`, { sourceMessageId: message.messageId });
      return;
    }
    await env.DB.prepare(`INSERT INTO whatsapp_sales_leads (id, phone, customer_name, status, created_at, updated_at)
      VALUES (?, ?, ?, 'awaiting_sector', datetime('now'), datetime('now'))`)
      .bind(crypto.randomUUID(), phone, message.customerName || null).run();
    await sendBotReply(env, credentials, phone, "¡Hola! Para revisar disponibilidad, cuéntanos ¿de qué sector nos escribes?", preferAudio);
    return;
  }
  // Acción desconocida o el modelo no devolvió texto en "reply": nunca dejar al cliente sin respuesta.
  await setBotSessionMode(env, phone, "human", "bot_unhandled_action");
  await sendBotReply(env, credentials, phone, "Ya te comunico con un agente de BPGO, en breve te responde por acá. 🙌", preferAudio);
}

async function ensureBotDebounceTable(env) {
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS whatsapp_bot_debounce (
    phone TEXT PRIMARY KEY,
    message_id TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`).run();
}

const BOT_REPLY_DEBOUNCE_MS = 6000;

// Los clientes suelen mandar la misma idea en 2-3 mensajes seguidos ("Hola tiene la misma cuenta" /
// "?" / "Me la podría mandar"). Sin esto, cada mensaje disparaba su propia llamada a la IA y su
// propia respuesta -- se sentía fragmentado y a veces contestaba al mensaje equivocado, como una
// persona real jamás lo haría (una persona espera a que el otro termine de escribir).
//
// markLatestMessage() e isStillLatestMessage() están separadas (en vez de una sola función que
// marca-y-espera) porque si Meta llega a entregar varios mensajes juntos en el MISMO webhook, el
// bucle de runBotForInboundMessages los procesa uno por uno con await -- si marcar y esperar fuera
// una sola operación, el primer mensaje ya estaría a mitad de su espera de 6s antes de que el
// segundo alcanzara siquiera a registrarse como "más nuevo", rompiendo el "gana el último". Por
// eso se marcan TODOS los mensajes del lote primero (rápido, sin esperar) y recién después se hace
// la espera de cada uno.
async function markLatestMessage(env, phone, messageId) {
  await ensureBotDebounceTable(env);
  await env.DB.prepare(`INSERT INTO whatsapp_bot_debounce (phone, message_id, updated_at) VALUES (?, ?, datetime('now'))
    ON CONFLICT(phone) DO UPDATE SET message_id = excluded.message_id, updated_at = datetime('now')`)
    .bind(phone, messageId).run();
}

async function isStillLatestMessage(env, phone, messageId, waitMs = BOT_REPLY_DEBOUNCE_MS) {
  await new Promise((resolve) => setTimeout(resolve, waitMs));
  const current = await env.DB.prepare("SELECT message_id FROM whatsapp_bot_debounce WHERE phone = ?").bind(phone).first();
  return current?.message_id === messageId;
}

// Si el mensaje que finalmente responde no trae adjunto propio (ej. el cliente mandó la foto del
// comprobante y enseguida "gracias" o el nombre del titular como mensaje aparte), se recupera el
// último adjunto reciente (<60s) de ese teléfono para no perder la evidencia visual del comprobante.
async function recentInboundMedia(env, phone) {
  // Solo imagen/documento son relevantes para arrastrar (evidencia de comprobante de pago). El
  // audio se transcribe aparte y su media_id no es un posible comprobante -- arrastrarlo igual
  // hacía que el bot describiera un audio como "un documento" al cliente (el texto de mediaNote en
  // callBotResponder asume documento para cualquier adjunto no-imagen).
  const row = await env.DB.prepare(`SELECT media_id, message_type, created_at FROM whatsapp_inbox_messages
    WHERE phone = ? AND direction = 'inbound' AND media_id IS NOT NULL AND message_type IN ('image', 'document')
    ORDER BY created_at DESC LIMIT 1`).bind(phone).first();
  if (!row || Date.now() - Date.parse(row.created_at) >= 60000) return null;
  return { mediaId: row.media_id, mediaType: row.message_type };
}

// Auditoría 2026-10-05: el bot quedó en un bucle de 22+ mensajes con OTRO bot automático (un número que
// contestaba con ofertas tipo "¡Hola, que alegría verte por acá!... Descubre las ofertas", "Te avisaremos
// en otra ocasión"), gastando IA y mensajes de Meta sin fin. Dos defensas independientes:
//  1) no se le responde a un mensaje que huele a respuesta automática de una empresa;
//  2) tope por teléfono: si el bot ya envió BOT_LOOP_MAX_REPLIES textos en BOT_LOOP_WINDOW_MIN minutos, se
//     deja de responder, la conversación pasa a atención humana y se avisa a Carlos una vez.
const BOT_LOOP_MAX_REPLIES = 8;
const BOT_LOOP_WINDOW_MIN = 10;

function isLikelyAutoReply(text) {
  const normalized = cyberNormalize(text);
  if (!normalized) return false;
  return /\b(mensaje automatico|respuesta automatica|este es un mensaje automatico|no responder a este mensaje|descubre las ofertas|que alegria verte por aca|te avisaremos en otra ocasion|ofertas exclusivas para ti|fuera de(l)? horario de atencion|nuestro horario de atencion es|gracias por contactar(nos| a)|hemos recibido tu mensaje|te responderemos a la brevedad|en este momento no (podemos|estamos))\b/.test(normalized);
}

// Caso real (2026-10-06, 56985843355 y 56987480455): con una visita/comprobante pendiente de nombre, CUALQUIER
// mensaje del cliente ("Buenas tardes", "Consulta cuánto sale una repetidora", "Podrían revisar qué pasa")
// recibía de vuelta "Necesito el nombre del titular...", una y otra vez, sin atender lo que preguntaba. Se
// pide el nombre como máximo 2 veces en 30 minutos; después se suelta el trámite pendiente y lo toma una
// persona, con lo que el cliente escribió.
const NAME_REQUEST_TEXT = "Necesito el nombre del titular del servicio, por ejemplo: Juan Pérez.";

async function askForAccountNameOrHandOff(env, credentials, phone, text, message, preferAudio) {
  const asked = await env.DB.prepare(`SELECT COUNT(*) AS n FROM whatsapp_inbox_messages WHERE phone = ? AND direction = 'outbound'
    AND message_text = ? AND created_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-30 minutes')`).bind(phone, NAME_REQUEST_TEXT).first();
  if ((asked?.n || 0) < 2) {
    await sendBotReply(env, credentials, phone, NAME_REQUEST_TEXT, preferAudio);
    return;
  }
  for (const table of ["whatsapp_pending_visits", "whatsapp_pending_payments", "whatsapp_pending_billing"]) {
    await env.DB.prepare(`DELETE FROM ${table} WHERE phone = ?`).bind(phone).run().catch(() => null);
  }
  await sendBotReply(env, credentials, phone, "Para ayudarte mejor, te va a escribir un agente por acá en breve. 🙏", preferAudio);
  await notifyStaff(env, credentials, "carlos", "Conversación escalada", await getKnownAccountName(env, phone).catch(() => null), phone,
    `No se logró obtener el nombre del titular tras pedirlo 2 veces; el cliente escribió: "${String(text || "").trim().slice(0, 150)}"`, { sourceMessageId: message.id });
  await setBotSessionMode(env, phone, "human", "bot_escalated");
}

// Caso real (2026-10-06): la IA mandó al cliente su nota interna en tercera persona ("El cliente quiere hablar
// con un ejecutivo y menciona que no recibió respuesta...") y prometió "Un técnico llegará a tu domicilio
// mañana en la mañana", horario que nadie confirmó. Se bloquea cualquier texto de la IA que hable del cliente
// en tercera persona o que prometa una hora/día de llegada del técnico.
function botTextProblem(text) {
  const value = String(text || "");
  if (/\b(el|la) cliente\b/i.test(value)) return "internal_note";
  const normalized = cyberNormalize(value);
  if (/\b(tecnico|visita)\b.{0,80}\b(manana|hoy|esta tarde|esta noche|en la tarde|a las \d)/.test(normalized)
    || /\b(manana|hoy|esta tarde|esta noche|a las \d).{0,80}\b(tecnico|visita)\b/.test(normalized)
    || /\bnos vemos (manana|hoy)\b/.test(normalized)) return "schedule_promise";
  // Caso real (2026-10-06): el modelo inventó que no se podían cambiar fechas de pago. Si no
  // existe una política explícita cargada, se deriva a una persona en vez de afirmarlo al cliente.
  if (/\b(no se puede(n)?|no esta permitido|no aceptamos|no realizamos|esta prohibido)\b/.test(normalized)
    && /\b(fecha(s)? de pago|dia(s)? de pago|politica|politicas)\b/.test(normalized)) return "unsupported_policy";
  return null;
}

function isPureGreeting(text) {
  const normalized = cyberNormalize(text).replace(/[^a-z ]/g, " ").replace(/\s+/g, " ").trim();
  return /^(hola|holi|ola|buenas|buenos dias|buen dia|buenas tardes|buenas noches|hola buenas|hola buenos dias|hola buen dia|hola buenas tardes|hola buenas noches)$/.test(normalized);
}

async function guardAgainstBotLoop(env, credentials, phone, message) {
  const text = inboundMessageText(message);
  if (isLikelyAutoReply(text)) return true;
  const recent = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM whatsapp_inbox_messages WHERE phone = ? AND direction = 'outbound' AND message_type = 'text'
     AND created_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ?)`
  ).bind(phone, `-${BOT_LOOP_WINDOW_MIN} minutes`).first();
  if ((recent?.n || 0) < BOT_LOOP_MAX_REPLIES) return false;
  await setBotSessionMode(env, phone, "human", "bot_loop_suspected");
  await notifyStaff(env, credentials, "carlos", "Conversación pausada", await getKnownAccountName(env, phone).catch(() => null), phone,
    `El bot envió ${recent.n} mensajes en ${BOT_LOOP_WINDOW_MIN} minutos a este número; puede ser otro bot o un bucle. Se pausó la conversación.`,
    { sourceMessageId: message.id }).catch(() => null);
  return true;
}

async function runBotForInboundMessages(env, changes) {
  if (String(env.WHATSAPP_BOT_ENABLED || "").toLowerCase() !== "true") return;
  const credentials = await getWhatsAppCredentials(env);
  if (!credentials.accessToken || !credentials.phoneNumberId) return;
  // Se marcan todos los mensajes de este webhook como "el más nuevo" de su teléfono ANTES de
  // procesar ninguno (ver el comentario en markLatestMessage/isStillLatestMessage).
  for (const change of changes) {
    for (const message of (Array.isArray(change.value?.messages) ? change.value.messages : [])) {
      if (message.id && message.from) await markLatestMessage(env, message.from, message.id).catch(() => null);
    }
  }
  for (const change of changes) {
    const value = change.value || {};
    const name = value.contacts?.[0]?.profile?.name || null;
    for (const message of (Array.isArray(value.messages) ? value.messages : [])) {
      const phone = message.from;
      try {
        if (message.id && !(await claimInboundMessageForBot(env, message.id))) continue;
        // Una reacción (👍 a un mensaje nuestro) no tiene texto ni adjunto real que analizar --
        // sin este corte, terminaba llamando a la IA con "(sin texto, ver adjunto)" y a veces
        // respondía algo como "no entendí, ¿me explicas de nuevo?" a un simple emoji.
        if (message.type === "reaction") continue;
        await ensureWhatsAppBotTables(env);
        const staffButtonPayload = message.button?.payload || null;
        const isStaffPhone = phone === normalizeWhatsAppPhone(env.STAFF_PHONE_CARLOS) || phone === normalizeWhatsAppPhone(env.STAFF_PHONE_EDUARDO);
        if (isStaffPhone && staffButtonPayload?.startsWith("confirm_payment:")) {
          // Carlos/Eduardo confirmaron el pago tocando el botón del aviso -- esto SÍ puede aplicar
          // el pago a la facturación real porque lo dispara una persona, no el bot (la regla de
          // "el bot nunca marca pagado solo" sigue intacta).
          const caseId = staffButtonPayload.slice("confirm_payment:".length);
          await ensureWhatsAppAutomationTable(env);
          const caseRow = await env.DB.prepare("SELECT id, phone, reported_name, customer_name, amount FROM whatsapp_automation_cases WHERE id = ?").bind(caseId).first();
          if (!caseRow) {
            await sendWhatsAppText(env, credentials, phone, "No encontré ese caso (puede que ya haya sido procesado). Revísalo en el panel.");
            continue;
          }
          const applied = await applyPaymentToBillingRecord(env, normalizeWhatsAppPhone(caseRow.phone), caseRow.amount).catch((error) => ({ ok: false, reason: String(error?.message || error) }));
          if (applied.ok) {
            await env.DB.prepare("UPDATE whatsapp_automation_cases SET status = 'approved', decision_note = ?, updated_at = datetime('now') WHERE id = ?")
              .bind("Pago confirmado y aplicado a facturación vía botón de WhatsApp.", caseId).run();
            const who = caseRow.reported_name || caseRow.customer_name || "el cliente";
            await sendWhatsAppText(env, credentials, phone, `✅ Listo, pago registrado para ${who} (${applied.record.reference || applied.record.billingMonth}). Saldo actualizado en facturación.`);
            // Carlos tocaba "Registrar pago" y el cliente se quedaba sin ninguna confirmación de
            // que su pago quedó aplicado -- solo el staff se enteraba.
            await sendWhatsAppText(env, credentials, normalizeWhatsAppPhone(caseRow.phone),
              "¡Hola! Hemos confirmado tu pago. 🎉 Tu servicio está activo. Si tienes alguna duda, no dudes en escribirnos. 😊").catch(() => null);
          } else {
            const reasonText = applied.reason === "no_pending_record"
              ? "no encontré un cobro pendiente para ese teléfono en facturación"
              : applied.reason === "ambiguous_record"
                ? "hay más de un cobro pendiente para ese cliente y no pude saber cuál es, revísalo en el panel"
                : "no pude aplicar el pago automáticamente, revísalo en el panel";
            await sendWhatsAppText(env, credentials, phone, `⚠️ No pude registrar el pago solo: ${reasonText}.`);
          }
          continue;
        }
        if (isStaffPhone && (staffButtonPayload?.startsWith("factibilidad_yes:") || staffButtonPayload?.startsWith("factibilidad_no:"))) {
          const isYes = staffButtonPayload.startsWith("factibilidad_yes:");
          const leadId = staffButtonPayload.slice(staffButtonPayload.indexOf(":") + 1);
          await ensureWhatsAppBotTables(env);
          const lead = await env.DB.prepare("SELECT * FROM whatsapp_sales_leads WHERE id = ?").bind(leadId).first();
          if (!lead) {
            await sendWhatsAppText(env, credentials, phone, "No encontré esa solicitud (puede que ya haya sido procesada).");
            continue;
          }
          // Un doble toque del botón (o una reentrega del webhook con un message.id distinto, que
          // claimInboundMessageForBot no detecta como duplicado) volvía a mandar los planes al
          // cliente por segunda vez. Solo se procesa mientras siga esperando la confirmación.
          if (lead.status !== "awaiting_factibilidad") {
            await sendWhatsAppText(env, credentials, phone, "Esa solicitud ya fue procesada antes.");
            continue;
          }
          if (!isYes) {
            await env.DB.prepare("UPDATE whatsapp_sales_leads SET status = 'no_factibilidad', updated_at = datetime('now') WHERE id = ?").bind(leadId).run();
            await sendWhatsAppText(env, credentials, lead.phone, NO_FACTIBILIDAD_MESSAGE);
            await sendWhatsAppText(env, credentials, phone, "Listo, le avisé al cliente que por ahora no hay factibilidad en su sector.");
            continue;
          }
          const group = matchPlanGroup(lead.sector);
          if (!group) {
            await env.DB.prepare("UPDATE whatsapp_sales_leads SET status = 'awaiting_group_clarification', updated_at = datetime('now') WHERE id = ?").bind(leadId).run();
            await sendWhatsAppText(env, credentials, phone, `No reconozco el sector "${lead.sector}". Respóndeme "cayucupil" o "otros" para saber qué planes ofrecerle.`);
            continue;
          }
          await env.DB.prepare("UPDATE whatsapp_sales_leads SET status = 'awaiting_plan', plan_group = ?, updated_at = datetime('now') WHERE id = ?").bind(group, leadId).run();
          await sendWhatsAppText(env, credentials, lead.phone, formatPlansMessage(group));
          await sendWhatsAppText(env, credentials, phone, `Listo, le envié los planes de ${PLAN_GROUPS[group].label}.`);
          continue;
        }
        if (isStaffPhone && staffButtonPayload === null) {
          // Texto libre de un número de staff: puede ser la aclaración de zona que pedimos cuando
          // el sector no se reconoció automáticamente (ver 'awaiting_group_clarification' arriba).
          const clarifyingLead = await env.DB.prepare(
            "SELECT * FROM whatsapp_sales_leads WHERE status = 'awaiting_group_clarification' ORDER BY updated_at DESC LIMIT 1"
          ).first();
          const staffText = String(message.text?.body || "").toLowerCase();
          if (clarifyingLead && staffText) {
            const group = staffText.includes("cayucupil") ? "cayucupil" : staffText.includes("otro") ? "otros" : null;
            if (group) {
              await env.DB.prepare("UPDATE whatsapp_sales_leads SET status = 'awaiting_plan', plan_group = ?, updated_at = datetime('now') WHERE id = ?").bind(group, clarifyingLead.id).run();
              await sendWhatsAppText(env, credentials, clarifyingLead.phone, formatPlansMessage(group));
              await sendWhatsAppText(env, credentials, phone, `Listo, le envié los planes de ${PLAN_GROUPS[group].label}.`);
              continue;
            }
          }
        }
        // Los botones de la campaña Cyber se atienden ANTES del filtro de atención humana: la campaña
        // también se envía a clientes marcados como "human", y su respuesta no puede perderse.
        if (await handleCyberReply(env, credentials, message)) continue;
        const sessionRow = await getBotSessionRow(env, phone);
        if (sessionRow?.mode === "human") {
          if (await shouldAutoReactivate(env, phone, sessionRow, message.id)) {
            await setBotSessionMode(env, phone, "bot", "auto_reactivated_after_inactivity");
            const safeReply = safeReplyForReactivatedBusinessHandoff(sessionRow.escalation_reason);
            if (safeReply) {
              await sendBotReply(env, credentials, phone, safeReply, message.type === "audio");
              continue;
            }
          } else {
            // El mensaje ya fue guardado en la bandeja. Mientras un humano tenga la conversación
            // (y no se cumplan las condiciones de reactivación automática de arriba), nunca se
            // llama a la IA ni se responde; "Reactivar bot" también puede devolverla al bot.
            await alertStaffCustomerWroteInHumanMode(env, credentials, phone, message).catch(() => null);
            continue;
          }
        }
        const recoveredHandoffReply = safeReplyForReactivatedBusinessHandoff(message.reactivatedHandoffReason);
        if (recoveredHandoffReply) {
          await sendBotReply(env, credentials, phone, recoveredHandoffReply, message.type === "audio");
          continue;
        }
        if (!isStaffPhone && await guardAgainstBotLoop(env, credentials, phone, message)) continue;
        const preferAudio = message.type === "audio";
        let text = inboundMessageText(message);
        if (preferAudio && message.audio?.id) {
          text = await transcribeWhatsAppAudio(env, credentials, message.audio.id).catch(() => null);
          if (text) {
            await ensureWhatsAppInboxTable(env);
            await env.DB.prepare("UPDATE whatsapp_inbox_messages SET message_text = ? WHERE message_id = ?")
              .bind(`🎤 ${text}`, message.id).run().catch(() => null);
            // El clasificador por reglas corrió con texto vacío cuando llegó el audio (antes de
            // transcribir); ahora que sabemos qué dice, corregimos el caso ya creado para que el
            // panel muestre el tipo/resumen correcto en vez de "Consulta general".
            const reclass = classifyInboundMessage({ text, mediaId: null, type: "text", createdAt: new Date().toISOString() });
            await ensureWhatsAppAutomationTable(env);
            await env.DB.prepare(`UPDATE whatsapp_automation_cases SET case_type = ?, confidence = ?, summary = ?,
              service_month = COALESCE(service_month, ?), amount = COALESCE(amount, ?), updated_at = datetime('now')
              WHERE source_message_id = ?`)
              .bind(reclass.type, reclass.confidence, reclass.summary, reclass.serviceMonth, reclass.amount, message.id).run().catch(() => null);
          }
        }
        await ensureWhatsAppBotTables(env);
        const salesLead = await env.DB.prepare(
          "SELECT * FROM whatsapp_sales_leads WHERE phone = ? AND status NOT IN ('completed','cancelled','no_factibilidad') ORDER BY created_at DESC LIMIT 1"
        ).bind(phone).first();
        if (String(text || "").trim() && isRestartRequest(text)) {
          await env.DB.prepare("UPDATE whatsapp_sales_leads SET status = 'cancelled', updated_at = datetime('now') WHERE phone = ? AND status NOT IN ('completed','cancelled','no_factibilidad')").bind(phone).run();
          await env.DB.prepare("DELETE FROM whatsapp_pending_visits WHERE phone = ?").bind(phone).run();
          await sendBotReply(env, credentials, phone, "Listo, empecemos de nuevo. 😊 ¿En qué te puedo ayudar?", preferAudio);
          continue;
        }
        // Duda sobre cómo se paga la instalación: respuesta fija con la política real, sin pasar por la
        // IA ni por el embudo (que la leería como dato de instalación). Dentro del embudo, un "¿y eso se
        // paga en la boleta?" sin mencionar la palabra instalación también es esta misma duda.
        const salesLeadPaying = salesLead && ["awaiting_plan", "awaiting_installation_data"].includes(salesLead.status)
          && looksLikeQuestion(text) && /\b(boleta|pago|pagar|paga|pagan|cobran|cobro)\b/.test(cyberNormalize(text));
        if (String(text || "").trim() && !isOptOutMessage(text) && (isInstallationPaymentQuestion(text) || salesLeadPaying)) {
          await sendBotReply(env, credentials, phone, `Al momento de la instalación se paga el costo de instalación ($${INSTALLATION_COST.toLocaleString("es-CL")}) más el mes de servicio por adelantado, proporcional a los días que resten del mes. No se cobra en la boleta. 😊\n\nCualquier otra duda, escríbenos.`, preferAudio);
          continue;
        }
        if (salesLead) {
          if (isOptOutMessage(text)) {
            await env.DB.prepare("UPDATE whatsapp_sales_leads SET status = 'cancelled', updated_at = datetime('now') WHERE id = ?").bind(salesLead.id).run();
            await sendBotReply(env, credentials, phone, "Entendido, no seguimos con la solicitud. Cualquier cosa, escríbenos. 🙌", preferAudio);
            continue;
          }
          if (salesLead.status === "awaiting_sector" && String(text || "").trim()) {
            const sector = String(text).trim().slice(0, 200);
            await env.DB.prepare("UPDATE whatsapp_sales_leads SET sector = ?, status = 'awaiting_location', updated_at = datetime('now') WHERE id = ?").bind(sector, salesLead.id).run();
            await sendBotReply(env, credentials, phone, "Perfecto, ahora por favor envíanos tu ubicación desde WhatsApp (ícono 📎 > Ubicación) para revisar la factibilidad exacta. 📍", preferAudio);
            continue;
          }
          if (salesLead.status === "awaiting_location") {
            if (message.location?.latitude && message.location?.longitude) {
              const { latitude, longitude } = message.location;
              await env.DB.prepare("UPDATE whatsapp_sales_leads SET latitude = ?, longitude = ?, status = 'awaiting_factibilidad', updated_at = datetime('now') WHERE id = ?")
                .bind(latitude, longitude, salesLead.id).run();
              await sendBotReply(env, credentials, phone, "¡Gracias! Ya estamos revisando la factibilidad en tu zona, te avisamos apenas tengamos la confirmación. 🙏", preferAudio);
              const mapsLink = `https://www.google.com/maps?q=${latitude},${longitude}`;
              await notifyStaff(env, credentials, "carlos", "Solicitud de factibilidad", name || salesLead.customer_name, phone,
                `Sector: ${salesLead.sector || "no indicado"}. Ubicación: ${mapsLink}`, { caseId: null, factibilidadLeadId: salesLead.id, sourceMessageId: message.id });
            } else {
              // Caso real (2026-10-02): una persona mayor que no sabía compartir la ubicación recibió
              // el mismo recordatorio 5 veces seguidas. Tras un primer recordatorio se escala a un
              // agente (con lo que escribió para ubicarla) en vez de repetirlo indefinidamente.
              const reminded = await env.DB.prepare(`SELECT COUNT(*) AS n FROM whatsapp_inbox_messages
                WHERE phone = ? AND direction = 'outbound' AND message_text = ? AND created_at >= replace(?, ' ', 'T')`)
                .bind(phone, LOCATION_REMINDER_MESSAGE, salesLead.created_at).first();
              if ((reminded?.n || 0) >= 1) {
                await sendBotReply(env, credentials, phone, "No te preocupes, si no puedes enviar la ubicación te ayuda un agente por acá en breve. 🙏", preferAudio);
                await notifyStaff(env, credentials, "carlos", "Solicitud de factibilidad sin ubicación", name || salesLead.customer_name, phone,
                  `Sector: ${salesLead.sector || "no indicado"}. No logra compartir la ubicación${String(text || "").trim() ? `; dijo: "${String(text).trim().slice(0, 150)}"` : ""}.`, { sourceMessageId: message.id });
                await setBotSessionMode(env, phone, "human", "case_created_new_customer");
              } else {
                await sendBotReply(env, credentials, phone, LOCATION_REMINDER_MESSAGE, preferAudio);
              }
            }
            continue;
          }
          if (salesLead.status === "awaiting_factibilidad") {
            // Se dice una sola vez: si ya fue lo último que se le escribió, no se repite igual.
            const FACTIBILIDAD_WAIT = "Seguimos revisando la factibilidad en tu sector, en breve te contactamos. 🙏";
            const lastOut = await env.DB.prepare("SELECT message_text FROM whatsapp_inbox_messages WHERE phone = ? AND direction = 'outbound' ORDER BY created_at DESC LIMIT 1").bind(phone).first();
            if (lastOut?.message_text !== FACTIBILIDAD_WAIT) await sendBotReply(env, credentials, phone, FACTIBILIDAD_WAIT, preferAudio);
            continue;
          }
          if (salesLead.status === "awaiting_plan" && String(text || "").trim()) {
            const plan = matchChosenPlan(salesLead.plan_group, text);
            if (plan) {
              await env.DB.prepare("UPDATE whatsapp_sales_leads SET chosen_plan = ?, status = 'awaiting_installation_data', updated_at = datetime('now') WHERE id = ?")
                .bind(`${plan.speed} ($${plan.price})`, salesLead.id).run();
              await sendBotReply(env, credentials, phone, planConfirmationMessage(plan), preferAudio);
              await sendBotReply(env, credentials, phone, INSTALLATION_DATA_REQUEST_MESSAGE, preferAudio);
            } else if (looksLikeQuestion(text)) {
              await sendBotReply(env, credentials, phone, "Voy a dejar esta consulta para que te la responda un agente en breve. 🙏", preferAudio);
              await notifyStaff(env, credentials, "carlos", "Consulta de venta", salesLead.customer_name, phone,
                `Cliente con factibilidad confirmada, antes de elegir plan preguntó: "${text}"`, { sourceMessageId: message.id });
              await setBotSessionMode(env, phone, "human", "case_created_new_customer");
            } else {
              // Caso real (2026-10-05, prueba desde un número personal): ante "Quiero contratar", "Plan
              // 30mb/s" y "Soy de Peleco" el bot repetía la misma lista de planes sin parar. Tras un
              // primer recordatorio se escala a un agente (con lo que escribió el cliente) en vez de
              // insistir; y si pidió una velocidad que no existe en su sector, se le dice eso primero.
              const planReminders = await env.DB.prepare(`SELECT COUNT(*) AS n FROM whatsapp_inbox_messages
                WHERE phone = ? AND direction = 'outbound' AND message_text LIKE ? AND created_at >= replace(?, ' ', 'T')`)
                .bind(phone, `%${PLAN_REMINDER_MARKER}%`, salesLead.created_at).first();
              if ((planReminders?.n || 0) >= 1) {
                await sendBotReply(env, credentials, phone, "Para ayudarte mejor, te va a escribir un agente por acá en breve. 🙏", preferAudio);
                await notifyStaff(env, credentials, "carlos", "Consulta de venta", salesLead.customer_name, phone,
                  `Cliente con factibilidad confirmada no logra elegir plan (sector: ${salesLead.sector || "no indicado"}); escribió: "${String(text).trim().slice(0, 150)}"`, { sourceMessageId: message.id });
                await setBotSessionMode(env, phone, "human", "case_created_new_customer");
              } else {
                const asked = String(text).toLowerCase().replace(/[.,]/g, "").match(/(\d+)\s*mb/);
                const offered = PLAN_GROUPS[salesLead.plan_group]?.plans.some((p) => parseInt(p.speed, 10) === Number(asked?.[1]));
                const prefix = asked && !offered ? `Ese plan no está disponible en tu sector. ` : "";
                await sendBotReply(env, credentials, phone, `${prefix}${formatPlanReminderMessage(salesLead.plan_group)}`, preferAudio);
              }
            }
            continue;
          }
          if (salesLead.status === "awaiting_installation_data" && String(text || "").trim()) {
            // El cliente puede mandar los datos todos juntos o de a poco, en cualquier orden -- se
            // van completando campo por campo y recién cuando estén todos se avisa a Carlos, nunca
            // antes (para no mandarle un caso a medio llenar).
            const fragment = classifyInstallationFragment(text, {
              name: salesLead.installation_name, address: salesLead.installation_address,
            });
            if (fragment) {
              const setClauses = Object.keys(fragment).map((field) => `installation_${field} = ?`).join(", ");
              await env.DB.prepare(`UPDATE whatsapp_sales_leads SET ${setClauses}, updated_at = datetime('now') WHERE id = ?`)
                .bind(...Object.values(fragment), salesLead.id).run();
            }
            const updatedLead = await env.DB.prepare("SELECT * FROM whatsapp_sales_leads WHERE id = ?").bind(salesLead.id).first();
            const missing = missingInstallationFields(updatedLead);
            if (!missing.length) {
              await env.DB.prepare("UPDATE whatsapp_sales_leads SET status = 'completed', updated_at = datetime('now') WHERE id = ?").bind(salesLead.id).run();
              await sendBotReply(env, credentials, phone, "¡Perfecto, ya tenemos todos tus datos! Un agente coordinará la instalación contigo a la brevedad. 🙌", preferAudio);
              await notifyStaff(env, credentials, "carlos", "Nueva contratación", updatedLead.installation_name || name || salesLead.customer_name, phone,
                `Sector: ${salesLead.sector || "no indicado"}. Plan: ${salesLead.chosen_plan}. RUT: ${updatedLead.installation_rut}. Tel: ${updatedLead.installation_phone}. Correo: ${updatedLead.installation_email}. Dirección: ${updatedLead.installation_address}. Coordinar instalación.`, { leadId: salesLead.id, sourceMessageId: message.id });
              await setBotSessionMode(env, phone, "human", "case_created_new_customer");
            } else {
              await sendBotReply(env, credentials, phone, `Anotado ✅ Todavía me falta: ${missing.join(", ")}.`, preferAudio);
            }
            continue;
          }
        }
        const pendingVisit = await env.DB.prepare("SELECT reason, preferred_date FROM whatsapp_pending_visits WHERE phone = ?").bind(phone).first();
        if (pendingVisit && String(text || "").trim()) {
          // Estábamos esperando el nombre del titular para completar una visita/incidencia
          // pendiente: se captura en código, sin pasar por la IA (más confiable y más barato).
          if (isOptOutMessage(text)) {
            await env.DB.prepare("DELETE FROM whatsapp_pending_visits WHERE phone = ?").bind(phone).run();
            await sendBotReply(env, credentials, phone, "Entendido, no registramos la visita. Escríbenos si cambias de opinión. 🙌", preferAudio);
            continue;
          }
          const reportedName = extractAccountName(text);
          if (!isPlausibleAccountName(reportedName)) {
            await askForAccountNameOrHandOff(env, credentials, phone, text, message, preferAudio);
            continue;
          }
          const customer = await findCustomerForWhatsApp(env, phone, reportedName);
          const transcript = await buildRecentTranscript(env, phone);
          const visitRow = await env.DB.prepare(`INSERT INTO whatsapp_visit_requests (phone, customer_id, customer_name, reported_name, preferred_date, reason, status, created_at, transcript)
            VALUES (?, ?, ?, ?, ?, ?, 'pending', datetime('now'), ?) RETURNING id`)
            .bind(phone, customer.id, customer.name, reportedName, pendingVisit.preferred_date, pendingVisit.reason, transcript).first();
          await env.DB.prepare("DELETE FROM whatsapp_pending_visits WHERE phone = ?").bind(phone).run();
          await sendBotReply(env, credentials, phone, `Gracias, registramos la solicitud a nombre de ${reportedName}. Un agente te confirmará el horario. 🙌`, preferAudio);
          await notifyStaff(env, credentials, "eduardo", "Incidencia técnica", reportedName, phone, pendingVisit.reason || "Cliente reportó una falla técnica.", { visitRequestId: visitRow?.id, sourceMessageId: message.id });
          await setBotSessionMode(env, phone, "human", "case_created_visit");
          continue;
        }
        const pendingPayment = await env.DB.prepare("SELECT case_id FROM whatsapp_pending_payments WHERE phone = ?").bind(phone).first();
        if (pendingPayment && String(text || "").trim()) {
          // Mismo mecanismo determinístico que las visitas: el próximo mensaje del cliente se
          // toma como el nombre del titular para el comprobante que ya quedó registrado.
          if (isOptOutMessage(text)) {
            await env.DB.prepare("DELETE FROM whatsapp_pending_payments WHERE phone = ?").bind(phone).run();
            await sendBotReply(env, credentials, phone, "Entendido, de todas formas dejamos tu comprobante en revisión. Cualquier cosa, escríbenos. 🙏", preferAudio);
            continue;
          }
          const reportedName = extractAccountName(text);
          if (!isPlausibleAccountName(reportedName)) {
            await askForAccountNameOrHandOff(env, credentials, phone, text, message, preferAudio);
            continue;
          }
          if (pendingPayment.case_id) {
            await ensureWhatsAppAutomationTable(env);
            await env.DB.prepare("UPDATE whatsapp_automation_cases SET reported_name = ?, updated_at = datetime('now') WHERE id = ?")
              .bind(reportedName, pendingPayment.case_id).run();
          }
          await env.DB.prepare("DELETE FROM whatsapp_pending_payments WHERE phone = ?").bind(phone).run();
          await sendBotReply(env, credentials, phone, `Gracias, dejamos tu comprobante asociado a nombre de ${reportedName}. El equipo lo confirmará pronto. 🙏`, preferAudio);
          const storedCase = pendingPayment.case_id
            ? await env.DB.prepare("SELECT summary FROM whatsapp_automation_cases WHERE id = ?").bind(pendingPayment.case_id).first().catch(() => null) : null;
          const storedCheck = String(storedCase?.summary || "").split("Verificación: ")[1] || "";
          await notifyStaff(env, credentials, "carlos", "Comprobante de pago", reportedName, phone, `Comprobante recibido. ${storedCheck}`.trim(), { caseId: pendingPayment.case_id || null, sourceMessageId: message.id });
          await setBotSessionMode(env, phone, "human", "case_created_payment");
          continue;
        }
        const pendingBilling = await env.DB.prepare("SELECT days_without_service, reason FROM whatsapp_pending_billing WHERE phone = ?").bind(phone).first();
        if (pendingBilling && String(text || "").trim()) {
          // Mismo mecanismo: el nombre del titular se captura del próximo mensaje, nunca se le
          // pide al modelo que calcule ni mencione un monto de descuento.
          if (isOptOutMessage(text)) {
            await env.DB.prepare("DELETE FROM whatsapp_pending_billing WHERE phone = ?").bind(phone).run();
            await sendBotReply(env, credentials, phone, "Entendido, no seguimos con la revisión. Cualquier cosa, escríbenos. 🙌", preferAudio);
            continue;
          }
          const reportedName = extractAccountName(text);
          if (!isPlausibleAccountName(reportedName)) {
            await askForAccountNameOrHandOff(env, credentials, phone, text, message, preferAudio);
            continue;
          }
          const customer = await findCustomerForWhatsApp(env, phone, reportedName);
          const transcript = await buildRecentTranscript(env, phone);
          const billingRow = await env.DB.prepare(`INSERT INTO whatsapp_billing_requests (phone, customer_id, customer_name, reported_name, days_without_service, reason, status, created_at, transcript)
            VALUES (?, ?, ?, ?, ?, ?, 'pending', datetime('now'), ?) RETURNING id`)
            .bind(phone, customer.id, customer.name, reportedName, pendingBilling.days_without_service, pendingBilling.reason, transcript).first();
          await env.DB.prepare("DELETE FROM whatsapp_pending_billing WHERE phone = ?").bind(phone).run();
          await sendBotReply(env, credentials, phone, `Gracias, registramos la solicitud a nombre de ${reportedName}. Un agente calculará el ajuste y te confirmará. 🙏`, preferAudio);
          await notifyStaff(env, credentials, "carlos", "Descuento por corte", reportedName, phone, pendingBilling.days_without_service ? `${pendingBilling.days_without_service} día(s) sin servicio. ${pendingBilling.reason || ""}` : (pendingBilling.reason || "Cliente pide revisión por corte de servicio."), { billingRequestId: billingRow?.id, sourceMessageId: message.id });
          await setBotSessionMode(env, phone, "human", "case_created_billing");
          continue;
        }
        if (!(await isStillLatestMessage(env, phone, message.id))) continue;
        let mediaId = message.image?.id || message.document?.id || null;
        let mediaType = message.type || "unknown";
        if (!mediaId) {
          const carriedOver = await recentInboundMedia(env, phone);
          if (carriedOver) { mediaId = carriedOver.mediaId; mediaType = carriedOver.mediaType; }
        }
        let media = null;
        if (mediaId) media = await fetchWhatsAppMediaBase64(credentials, mediaId).catch(() => null);
        const context = await buildBotContext(env, phone, name);
        const action = await callBotResponder(env, context, { type: message.type || "unknown", text }, media);
        // La llamada a la IA puede tardar varios segundos. Si el cliente mandó dos mensajes seguidos
        // en webhooks SEPARADOS (no en el mismo lote, donde el truco de marcar-todos-primero ya
        // protege), cada uno pasa su propio chequeo de "más nuevo" ANTES de llamar a la IA porque en
        // ese momento de verdad lo era -- el problema aparece si el primero en llegar es más lento en
        // responder (por latencia del modelo) y el segundo ya se envió y marcó mientras tanto: sin
        // este segundo chequeo, ambos terminaban mandando una respuesta (a veces idéntica, porque para
        // entonces el contexto de ambos ya incluía el mensaje más nuevo). Se repite el chequeo recién
        // acá, justo antes de ejecutar la acción, sin espera adicional (ya se esperó lo suficiente).
        if (!(await isStillLatestMessage(env, phone, message.id, 0))) continue;
        await executeBotAction(env, credentials, phone, action, {
          customerName: name, messageId: message.id, preferAudio, customerText: text,
          mediaId, mediaType, mediaMime: media?.mimeType || null,
        });
      } catch (error) {
        // Caso real (2026-10-06, 56962138241): "El de 25" dejó la conversación en silencio con un
        // bot_exception y nadie supo por qué. Ahora el error queda en el log y llega a Carlos con el
        // detalle; la conversación pasa a humano (como antes) y, al ser un fallo del bot y no una
        // decisión humana, el bot la retoma sola (ver AUTO_REACTIVATABLE_REASONS y la retoma de 5 min).
        const detail = String(error?.message || error).replace(/\s+/g, " ").slice(0, 160);
        console.error("bot_exception", phone, detail);
        await setBotSessionMode(env, phone, "human", "bot_exception").catch(() => null);
        await notifyStaff(env, credentials, "carlos", "Error del bot", await getKnownAccountName(env, phone).catch(() => null), phone,
          `El bot falló al responder (${detail}). Se pausó esta conversación; el bot la retoma solo en unos minutos.`,
          { sourceMessageId: message.id }).catch(() => null);
      }
    }
  }
}

async function createAutomationCase(env, message) {
  await ensureWhatsAppAutomationTable(env);
  const classification = classifyInboundMessage(message);
  const customer = await findCustomerForWhatsApp(env, message.phone, message.customerName);
  const id = crypto.randomUUID();
  await env.DB.prepare(`INSERT OR IGNORE INTO whatsapp_automation_cases
    (id, source_message_id, phone, customer_name, customer_id, case_type, confidence, status, summary,
     service_month, amount, media_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'suggested', ?, ?, ?, ?, ?, datetime('now'))`)
    .bind(id, message.messageId, message.phone, customer.name, customer.id, classification.type,
      classification.confidence, classification.summary, classification.serviceMonth, classification.amount,
      message.mediaId || null, message.createdAt)
    .run();
}

async function saveInboundWhatsAppMessages(env, changes) {
  await ensureWhatsAppInboxTable(env);
  let saved = 0;
  for (const change of changes) {
    const value = change.value || {};
    const name = value.contacts?.[0]?.profile?.name || null;
    for (const message of (Array.isArray(value.messages) ? value.messages : [])) {
      const text = inboundMessageText(message);
      const mediaId = message.image?.id || message.document?.id || message.audio?.id || message.video?.id || null;
      await env.DB.prepare(`INSERT OR IGNORE INTO whatsapp_inbox_messages
        (message_id, phone, customer_name, direction, message_type, message_text, media_id, created_at, raw_json)
        VALUES (?, ?, ?, 'inbound', ?, ?, ?, ?, ?)`)
        .bind(message.id, message.from, name, message.type || "unknown", text, mediaId, new Date(Number(message.timestamp || 0) * 1000).toISOString(), JSON.stringify(message))
        .run();
      // En handoff humano el webhook conserva el mensaje en la bandeja, pero no lo clasifica ni
      // crea automatizaciones. El operador debe reactivar el bot explícitamente desde Operaciones.
      if (await getBotSessionMode(env, message.from) !== "human") {
        if (cyberButtonAction(message)) { saved += 1; continue; }
        await createAutomationCase(env, {
          messageId: message.id,
          phone: message.from,
          customerName: name,
          type: message.type || "unknown",
          text,
          mediaId,
          createdAt: new Date(Number(message.timestamp || 0) * 1000).toISOString(),
        }).catch(() => null);
      }
      saved += 1;
    }
  }
  return saved;
}

function extractWhatsAppMessageEchoes(changes) {
  const echoes = [];
  for (const change of changes) {
    const value = change.value || {};
    const candidates = [value.message_echoes, value.smb_message_echoes];
    if (change.field === "smb_message_echoes") candidates.push(value.messages, value.data);
    // Algunos payloads de coexistencia llegan bajo "messages", pero el mensaje saliente incluye
    // destinatario (to); un inbound normal solo trae from.
    if (Array.isArray(value.messages)) candidates.push(value.messages.filter((message) => message?.to));
    for (const list of candidates) if (Array.isArray(list)) echoes.push(...list);
  }
  return Array.from(new Map(echoes.filter((item) => item?.id).map((item) => [item.id, item])).values());
}

async function isKnownApiOutboundMessage(env, messageId) {
  await ensureWhatsAppInboxTable(env);
  await ensureWhatsAppStatusTable(env);
  await ensureStaffNotificationsLogTable(env);
  const inbox = await env.DB.prepare("SELECT 1 AS found FROM whatsapp_inbox_messages WHERE message_id=? AND direction='outbound'").bind(messageId).first();
  if (inbox) return true;
  const status = await env.DB.prepare("SELECT 1 AS found FROM whatsapp_message_status WHERE message_id=?").bind(messageId).first();
  if (status) return true;
  const staff = await env.DB.prepare("SELECT 1 AS found FROM staff_notifications_log WHERE message_id=? OR fallback_message_id=?").bind(messageId, messageId).first();
  if (staff) return true;
  await ensureWhatsAppCampaignTable(env);
  const campaign = await env.DB.prepare("SELECT 1 AS found FROM whatsapp_campaign_sends WHERE message_id=?").bind(messageId).first();
  return Boolean(campaign);
}

async function saveManualWhatsAppEchoes(env, changes) {
  const echoes = extractWhatsAppMessageEchoes(changes);
  let saved = 0;
  for (const message of echoes) {
    if (await isKnownApiOutboundMessage(env, message.id)) continue;
    const phone = normalizeWhatsAppPhone(message.to || message.recipient_id);
    if (!phone) continue;
    const text = inboundMessageText(message);
    const mediaId = message.image?.id || message.document?.id || message.audio?.id || message.video?.id || null;
    await ensureWhatsAppInboxTable(env);
    await env.DB.prepare(`INSERT OR IGNORE INTO whatsapp_inbox_messages
      (message_id, phone, direction, message_type, message_text, media_id, created_at, raw_json)
      VALUES (?, ?, 'outbound', ?, ?, ?, ?, ?)`)
      .bind(message.id, phone, message.type || "unknown", text, mediaId,
        new Date(Number(message.timestamp || 0) * 1000 || Date.now()).toISOString(), JSON.stringify(message)).run();
    await setBotSessionMode(env, phone, "human", "manual_whatsapp_reply");
    saved += 1;
  }
  return saved;
}

function inboundOnlyChanges(changes) {
  return changes.filter((change) => change.field !== "smb_message_echoes").map((change) => ({
    ...change,
    value: { ...change.value, messages: Array.isArray(change.value?.messages) ? change.value.messages.filter((message) => !message?.to) : change.value?.messages },
  }));
}

const BILLING_AUTOMATION_TEMPLATES = {
  day20: {
    name: "recordatorio_pago_bpgo_dia20",
    text: "Hola. Te recordamos que tu mensualidad BP GO se encuentra pendiente de pago. Puedes regularizarla en https://bpgo.cl/pagar. Si ya pagaste, envíanos tu comprobante por este medio. BP GO",
  },
  day22: {
    name: "recordatorio_pago_bpgo_dia22",
    text: "Hola. Tu mensualidad BP GO continúa pendiente de pago. Para evitar la suspensión del servicio, puedes regularizarla en https://bpgo.cl/pagar. Si ya pagaste, envíanos tu comprobante por este medio. BP GO",
  },
  day23: {
    name: "aviso_suspension_pago_bpgo",
    text: "Estimado/a, según nuestros registros tu mensualidad BP GO continúa pendiente. Si no regularizas el pago durante hoy, el servicio será suspendido por no pago. Puedes pagar en https://bpgo.cl/pagar. Si ya pagaste, envíanos tu comprobante por este medio. BP GO",
  },
};

const BILLING_MONTHS_ES = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];

function chileDateParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Santiago", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(date).reduce((result, part) => ({ ...result, [part.type]: part.value }), {});
  return { year: Number(parts.year), month: Number(parts.month), day: Number(parts.day) };
}

function billingStageForDate(date = new Date()) {
  const day = chileDateParts(date).day;
  return day === 20 ? "day20" : day === 22 ? "day22" : day === 23 ? "day23" : null;
}

function billingMonthKey(date = new Date()) {
  const local = chileDateParts(date);
  return `${local.year}-${String(local.month).padStart(2, "0")}`;
}

function normalizeSheetHeader(value) {
  return String(value || "").trim().toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/\s+/g, " ");
}

function parseBillingAmount(value) {
  const digits = String(value ?? "").replace(/[^\d-]/g, "");
  if (!digits) return null;
  const amount = Number(digits);
  return Number.isFinite(amount) ? amount : null;
}

function billingSheetColumns(rows, date = new Date()) {
  const headers = Array.isArray(rows?.[0]) ? rows[0].map(normalizeSheetHeader) : [];
  const monthName = BILLING_MONTHS_ES[chileDateParts(date).month - 1];
  const monthMatches = headers.map((header, index) => ({ header, index }))
    .filter((item) => item.header === monthName);
  return {
    customerId: headers.indexOf("id del cliente"),
    customerName: headers.indexOf("nombre del cliente"),
    address: headers.indexOf("direccion"),
    sector: headers.indexOf("sector"),
    phone: headers.indexOf("telefono"),
    plan: headers.indexOf("plan contratado"),
    amount: headers.indexOf("monto total"),
    accountStatus: headers.indexOf("estado bpgo"),
    month: monthMatches.length ? monthMatches[monthMatches.length - 1].index : -1,
  };
}

function billingEligibilityFromRows(rows, date = new Date(), pendingReceiptPhones = new Set()) {
  const columns = billingSheetColumns(rows, date);
  if (Object.values(columns).some((index) => index < 0)) {
    return { ok: false, error: "La planilla no contiene todas las columnas obligatorias del mes vigente.", eligible: [], excluded: [] };
  }
  const candidates = [];
  for (const row of rows.slice(1)) {
    if (!Array.isArray(row) || !row.some((value) => String(value || "").trim())) continue;
    const phone = normalizeWhatsAppPhone(row[columns.phone]);
    candidates.push({
      customerId: String(row[columns.customerId] || "").trim(),
      customerName: String(row[columns.customerName] || "").trim(),
      address: String(row[columns.address] || "").trim(),
      sector: String(row[columns.sector] || "").trim(),
      phone,
      plan: String(row[columns.plan] || "").trim(),
      amount: parseBillingAmount(row[columns.amount]),
      monthStatus: String(row[columns.month] || "").trim().toUpperCase(),
      accountStatus: String(row[columns.accountStatus] || "").trim().toUpperCase(),
    });
  }
  const phoneCounts = candidates.reduce((map, item) => map.set(item.phone, (map.get(item.phone) || 0) + 1), new Map());
  const eligible = [];
  const excluded = [];
  for (const item of candidates) {
    let reason = null;
    if (!/^56\d{9}$/.test(item.phone)) reason = "invalid_phone";
    else if ((phoneCounts.get(item.phone) || 0) > 1) reason = "duplicate_phone";
    else if (item.monthStatus === "PAGADO") reason = "paid";
    else if (item.monthStatus) reason = "month_not_pending";
    else if (/CORTADO|SUSPENDIDO|INACTIV/.test(item.accountStatus)) reason = "inactive_or_suspended";
    else if (!(item.amount > 0)) reason = "non_positive_amount";
    else if (pendingReceiptPhones.has(item.phone)) reason = "pending_receipt";
    (reason ? excluded : eligible).push(reason ? { ...item, reason } : item);
  }
  return { ok: true, columns, eligible, excluded };
}

async function ensureBillingAutomationTables(env) {
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS billing_automation_sends (
    id INTEGER PRIMARY KEY AUTOINCREMENT, billing_month TEXT NOT NULL, stage TEXT NOT NULL, phone TEXT NOT NULL,
    customer_id TEXT, customer_name TEXT, amount INTEGER, template_name TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
    message_id TEXT, error_code TEXT, error_message TEXT, is_test INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`).run();
  await env.DB.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_billing_automation_unique ON billing_automation_sends(billing_month, stage, phone) WHERE is_test=0").run();
  await env.DB.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_billing_automation_message ON billing_automation_sends(message_id) WHERE message_id IS NOT NULL").run();
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS billing_suspension_queue (
    id INTEGER PRIMARY KEY AUTOINCREMENT, billing_month TEXT NOT NULL, phone TEXT NOT NULL, customer_id TEXT,
    customer_name TEXT, sector TEXT, plan TEXT, amount INTEGER, status TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(billing_month, phone)
  )`).run();
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS billing_automation_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT, billing_month TEXT NOT NULL, stage TEXT, status TEXT NOT NULL,
    eligible_count INTEGER NOT NULL DEFAULT 0, excluded_count INTEGER NOT NULL DEFAULT 0,
    sent_count INTEGER NOT NULL DEFAULT 0, failed_count INTEGER NOT NULL DEFAULT 0, details TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`).run();
}

async function fetchFreshBillingSource(env) {
  const endpoint = String(env.BILLING_SHEETS_SYNC_URL || `https://${STABLE_BACKEND}/api/billing/sheets-sync`).trim();
  const response = await fetch(endpoint, { headers: { "cache-control": "no-cache" }, cache: "no-store" }).catch(() => null);
  const payload = response ? await response.json().catch(() => null) : null;
  if (!response?.ok || !payload?.ok || !Array.isArray(payload.rows)) throw new Error("No se pudo leer Google Sheets; lote abortado sin envíos.");
  return payload;
}

async function pendingPaymentReceiptPhones(env, month) {
  await ensureWhatsAppAutomationTable(env);
  // 'suggested'/'reviewing' pausan el envío mientras Carlos revisa el comprobante. Una vez que lo
  // aprueba ('approved'), el cliente debe seguir excluido de la cobranza del MISMO mes aunque a
  // alguien se le olvide marcar "PAGADO" en la planilla de Google Sheets -- si no, el sistema le
  // vuelve a mandar recordatorios a alguien que ya pagó y Carlos ya confirmó. Se limita al mes de
  // cobranza vigente para no bloquear para siempre a un cliente que vuelva a deber el mes siguiente.
  const rows = await env.DB.prepare(`SELECT DISTINCT phone FROM whatsapp_automation_cases
    WHERE case_type='payment' AND (status IN ('suggested','reviewing')
      OR (status='approved' AND strftime('%Y-%m', created_at) = ?))`).bind(month || "").all();
  return new Set((rows.results || []).map((item) => normalizeWhatsAppPhone(item.phone)).filter(Boolean));
}

function billingAutomationTemplateDefinition(stage) {
  const definition = BILLING_AUTOMATION_TEMPLATES[stage];
  return definition ? {
    name: definition.name,
    language: "es_CL",
    category: "UTILITY",
    components: [
      { type: "BODY", text: definition.text },
      { type: "BUTTONS", buttons: [
        { type: "QUICK_REPLY", text: "Ya pagué" },
        { type: "QUICK_REPLY", text: "Necesito link de pago" },
        { type: "QUICK_REPLY", text: "Hablar con ejecutivo" },
      ] },
    ],
  } : null;
}

async function syncBillingAutomationTemplates(env, createMissing = false) {
  const credentials = await getWhatsAppCredentials(env);
  if (!credentials.accessToken || !credentials.wabaId) return { ok: false, error: "Faltan credenciales WABA.", templates: [] };
  const endpoint = `https://graph.facebook.com/v25.0/${encodeURIComponent(credentials.wabaId)}/message_templates`;
  const response = await fetch(`${endpoint}?fields=name,status,language,category,rejected_reason&limit=200`, {
    headers: { authorization: `Bearer ${credentials.accessToken}` },
  }).catch(() => null);
  const payload = response ? await response.json().catch(() => ({})) : {};
  if (!response?.ok) return { ok: false, error: payload.error?.message || "Meta no permitió consultar plantillas.", templates: [] };
  let existing = Array.isArray(payload.data) ? payload.data : [];
  const created = [];
  if (createMissing) {
    for (const stage of Object.keys(BILLING_AUTOMATION_TEMPLATES)) {
      const definition = billingAutomationTemplateDefinition(stage);
      if (existing.some((item) => item.name === definition.name && item.language === definition.language)) continue;
      const createdResponse = await fetch(endpoint, {
        method: "POST",
        headers: { authorization: `Bearer ${credentials.accessToken}`, "content-type": "application/json" },
        body: JSON.stringify(definition),
      }).catch(() => null);
      const createdPayload = createdResponse ? await createdResponse.json().catch(() => ({})) : {};
      created.push({ name: definition.name, ok: Boolean(createdResponse?.ok), response: sanitizeMetaDiagnostic(createdPayload) });
    }
    if (created.some((item) => item.ok)) {
      const refreshed = await fetch(`${endpoint}?fields=name,status,language,category,rejected_reason&limit=200`, {
        headers: { authorization: `Bearer ${credentials.accessToken}` },
      }).catch(() => null);
      const refreshedPayload = refreshed ? await refreshed.json().catch(() => ({})) : {};
      if (refreshed?.ok && Array.isArray(refreshedPayload.data)) existing = refreshedPayload.data;
    }
  }
  const templates = Object.entries(BILLING_AUTOMATION_TEMPLATES).map(([stage, definition]) => {
    const found = existing.find((item) => item.name === definition.name && item.language === "es_CL");
    return { stage, name: definition.name, status: found?.status || "NOT_FOUND", language: found?.language || "es_CL", category: found?.category || "UTILITY", rejectedReason: found?.rejected_reason || null };
  });
  return { ok: true, templates, created };
}

async function sendBillingAutomationTemplate(env, stage, phone) {
  const credentials = await getWhatsAppCredentials(env);
  const definition = billingAutomationTemplateDefinition(stage);
  const endpoint = `https://graph.facebook.com/v25.0/${encodeURIComponent(credentials.phoneNumberId)}/messages`;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { authorization: `Bearer ${credentials.accessToken}`, "content-type": "application/json" },
    body: JSON.stringify({ messaging_product: "whatsapp", recipient_type: "individual", to: phone, type: "template", template: { name: definition.name, language: { code: definition.language } } }),
  }).catch(() => null);
  const payload = response ? await response.json().catch(() => ({})) : {};
  return { ok: Boolean(response?.ok && payload.messages?.[0]?.id), httpStatus: response?.status || 0, messageId: payload.messages?.[0]?.id || null, errorCode: payload.error?.code || null, error: payload.error?.message || null };
}

async function updateBillingAutomationStatus(env, item) {
  await ensureBillingAutomationTables(env);
  await env.DB.prepare(`UPDATE billing_automation_sends SET status=?, error_code=?, error_message=?, updated_at=datetime('now') WHERE message_id=?`)
    .bind(item.status, item.error?.code ? String(item.error.code) : null, item.error?.message || item.error?.error_data?.details || null, item.messageId).run();
}

async function revalidateBillingRecipient(env, phone, date = new Date()) {
  const source = await fetchFreshBillingSource(env);
  const parsed = billingEligibilityFromRows(source.rows, date, await pendingPaymentReceiptPhones(env, billingMonthKey(date)));
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.eligible.find((item) => item.phone === phone) || null;
}

async function reconcileBillingSuspensionQueue(env, month, parsed) {
  if (!parsed?.ok) return;
  for (const item of parsed.excluded) {
    const status = item.reason === "paid" ? "paid" : item.reason === "inactive_or_suspended" ? "suspended" : null;
    if (!status) continue;
    await env.DB.prepare(`UPDATE billing_suspension_queue SET status=?,updated_at=datetime('now')
      WHERE billing_month=? AND phone=? AND status='pending'`).bind(status, month, item.phone).run();
  }
}

async function runBillingAutomation(env, options = {}) {
  await ensureBillingAutomationTables(env);
  const date = options.date || new Date();
  const stage = options.stage || billingStageForDate(date);
  const month = billingMonthKey(date);
  const templateState = await syncBillingAutomationTemplates(env, true);
  if (!stage) return { ok: true, skipped: true, reason: "not_scheduled_day", month, templates: templateState.templates || [] };
  if (!BILLING_AUTOMATION_TEMPLATES[stage]) return { ok: false, error: "Etapa de cobranza inválida." };
  let source;
  try { source = await fetchFreshBillingSource(env); } catch (error) {
    await env.DB.prepare("INSERT INTO billing_automation_runs (billing_month,stage,status,details) VALUES (?,?,'aborted',?)").bind(month, stage, String(error.message || error)).run();
    return { ok: false, aborted: true, error: String(error.message || error) };
  }
  const parsed = billingEligibilityFromRows(source.rows, date, await pendingPaymentReceiptPhones(env, month));
  if (!parsed.ok) return { ok: false, aborted: true, error: parsed.error };
  await reconcileBillingSuspensionQueue(env, month, parsed);
  if (stage === "day23") {
    for (const item of parsed.eligible) {
      await env.DB.prepare(`INSERT INTO billing_suspension_queue
        (billing_month,phone,customer_id,customer_name,sector,plan,amount,status,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,'pending',datetime('now'),datetime('now'))
        ON CONFLICT(billing_month,phone) DO UPDATE SET customer_id=excluded.customer_id,customer_name=excluded.customer_name,
          sector=excluded.sector,plan=excluded.plan,amount=excluded.amount,updated_at=datetime('now')`)
        .bind(month, item.phone, item.customerId, item.customerName, item.sector, item.plan, item.amount).run();
    }
  }
  const template = (templateState.templates || []).find((item) => item.stage === stage);
  if (!templateState.ok || template?.status !== "APPROVED") {
    await env.DB.prepare(`INSERT INTO billing_automation_runs
      (billing_month,stage,status,eligible_count,excluded_count,details) VALUES (?,?,'blocked',?,?,?)`)
      .bind(month, stage, parsed.eligible.length, parsed.excluded.length, `Plantilla ${template?.status || "NOT_FOUND"}`).run();
    return { ok: false, blocked: true, error: "La plantilla de Meta no está aprobada.", month, stage, template, eligible: parsed.eligible.length, excluded: parsed.excluded.length };
  }
  let sent = 0;
  let failed = 0;
  for (const candidate of parsed.eligible) {
    const previous = await env.DB.prepare(`SELECT status FROM billing_automation_sends
      WHERE billing_month=? AND stage=? AND phone=? AND is_test=0`).bind(month, stage, candidate.phone).first();
    if (previous && ["accepted", "sent", "delivered", "read"].includes(previous.status)) continue;
    let item;
    try { item = await revalidateBillingRecipient(env, candidate.phone, date); } catch (error) {
      await env.DB.prepare(`INSERT INTO billing_automation_runs
        (billing_month,stage,status,eligible_count,excluded_count,sent_count,failed_count,details)
        VALUES (?,?,'aborted',?,?,?,?,?)`).bind(month, stage, parsed.eligible.length, parsed.excluded.length, sent, failed, String(error.message || error)).run();
      return { ok: false, aborted: true, error: "Google Sheets falló durante la revalidación; lote detenido.", sent, failed };
    }
    if (!item) continue;
    await env.DB.prepare(`INSERT INTO billing_automation_sends
      (billing_month,stage,phone,customer_id,customer_name,amount,template_name,status,is_test,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,'pending',0,datetime('now'),datetime('now'))
      ON CONFLICT(billing_month,stage,phone) WHERE is_test=0 DO UPDATE SET status='pending',error_code=NULL,error_message=NULL,updated_at=datetime('now')`)
      .bind(month, stage, item.phone, item.customerId, item.customerName, item.amount, template.name).run();
    const result = await sendBillingAutomationTemplate(env, stage, item.phone);
    await env.DB.prepare(`UPDATE billing_automation_sends SET status=?,message_id=?,error_code=?,error_message=?,updated_at=datetime('now')
      WHERE billing_month=? AND stage=? AND phone=? AND is_test=0`)
      .bind(result.ok ? "accepted" : "failed", result.messageId, result.errorCode ? String(result.errorCode) : null, result.error, month, stage, item.phone).run();
    if (result.ok) sent += 1; else failed += 1;
  }
  if (stage === "day23" && parsed.eligible.length) {
    await notifyStaff(env, await getWhatsAppCredentials(env), "carlos", "Cobranza automática", "Lista de suspensión", "interno",
      `${parsed.eligible.length} cliente(s) pendientes de suspensión por un total de ${formatCurrency(parsed.eligible.reduce((sum, item) => sum + item.amount, 0))}. Revisar Operaciones.`,
      { billingRequestId: `suspension-${month}`, sourceMessageId: `billing-${month}-day23` }).catch(() => null);
  }
  await env.DB.prepare(`INSERT INTO billing_automation_runs
    (billing_month,stage,status,eligible_count,excluded_count,sent_count,failed_count,details)
    VALUES (?,?,'completed',?,?,?,?,?)`).bind(month, stage, parsed.eligible.length, parsed.excluded.length, sent, failed, null).run();
  return { ok: failed === 0, month, stage, eligible: parsed.eligible.length, excluded: parsed.excluded.length, sent, failed, templates: templateState.templates };
}

async function billingAutomationDashboard(env) {
  await ensureBillingAutomationTables(env);
  const month = billingMonthKey();
  const source = await fetchFreshBillingSource(env).catch(() => null);
  const parsed = source ? billingEligibilityFromRows(source.rows, new Date(), await pendingPaymentReceiptPhones(env, month)) : null;
  if (parsed?.ok) await reconcileBillingSuspensionQueue(env, month, parsed);
  const sends = await env.DB.prepare(`SELECT stage,status,COUNT(*) AS count FROM billing_automation_sends
    WHERE billing_month=? AND is_test=0 GROUP BY stage,status`).bind(month).all();
  const queue = await env.DB.prepare(`SELECT id,billing_month,phone,customer_id,customer_name,sector,plan,amount,status,created_at,updated_at
    FROM billing_suspension_queue WHERE billing_month=? ORDER BY created_at DESC`).bind(month).all();
  const templates = await syncBillingAutomationTemplates(env, false);
  const queueRows = queue.results || [];
  return {
    ok: true, month, sourceFresh: Boolean(source), pending: parsed?.eligible.length ?? null, excluded: parsed?.excluded.length ?? null,
    pendingAmount: parsed ? parsed.eligible.reduce((sum, item) => sum + item.amount, 0) : null,
    sends: sends.results || [], queue: queueRows,
    queuePending: queueRows.filter((item) => item.status === "pending").length,
    queueAmount: queueRows.filter((item) => item.status === "pending").reduce((sum, item) => sum + Number(item.amount || 0), 0),
    templates: templates.templates || [], templateError: templates.ok ? null : templates.error,
  };
}

// Cyber upgrade uses the existing campaign ledger and bot handoff, never changes plans.
// v2 (2026-10-01): el texto original se sentía "plano" (pedido explícito del usuario de hacerlo
// más emocionante/promocional, con el % de descuento destacado) y se le agregó un banner con el
// logo real de BP GO. Un id/template NUEVO en vez de editar el anterior porque (a) Meta no deja
// editar en el sitio una plantilla ya aprobada sin reiniciar la revisión, y (b) el id viejo ya
// tiene 29 intentos fallidos por un problema de pago de Meta (ver retryCyberFailed) que no tiene
// sentido mezclar con esta campaña nueva, que parte limpia.
const CYBER_UPGRADE = Object.freeze({
  id: "cyber_oro_platino_v2", template: "cyber_oro_platino_v2", language: "es_CL",
  start: "2026-09-30", end: "2026-10-05", timezone: "America/Santiago",
  text: "🎉 ¡CYBER BP GO está aquí! 🎉\n\n🚀 Mejora tu Plan Oro a *Plan Platino 300 Mb/s* — 3 veces más veloz.\n\n🔥 *12% de descuento*: paga solo *$21.990/mes* durante 6 meses (precio normal $25.000).\n\n✅ Más velocidad para ver, trabajar y jugar sin cortes.\n\n⏰ Promoción disponible hasta el lunes 5 de octubre.\n\n¿Te interesa solicitar el cambio? 👇",
  buttons: ["Me interesa", "Hablar con ejecutivo", "Ahora no"],
  bannerPath: "/assets/cyber-banner-v2.png",
});

// Plantilla de respaldo SOLO TEXTO (2026-10-02): v2 (con banner) llevaba más de un día "En revisión" y
// la promo cierra el 5/10. Misma campaña (mismo id => mismos envíos, botones y respuestas), pero con otro
// nombre de plantilla y otro cuerpo -- Meta rechaza como duplicada una plantilla con el mismo cuerpo
// y pie que otra existente, así que NO puede ser el mismo texto. Sin encabezado de imagen, por lo que
// no depende de la revisión del banner. El envío usa la primera variante aprobada (imagen primero).
const CYBER_TEMPLATE_VARIANTS = Object.freeze({
  image: Object.freeze({ template: CYBER_UPGRADE.template, text: CYBER_UPGRADE.text, header: true }),
  text: Object.freeze({
    template: "cyber_oro_platino_v2_texto",
    text: "🔥 ¡CYBER BP GO! Sube de Plan Oro a *Plan Platino 300 Mb/s*, 3 veces más veloz 🚀\n\n💥 *12% de descuento*: pagas solo *$21.990/mes* durante 6 meses (valor normal $25.000).\n\n✅ Más velocidad para ver, trabajar y jugar sin cortes.\n⏰ Válido hasta el lunes 5 de octubre.\n\n¿Quieres que te hagamos el cambio? 👇",
    header: false,
  }),
});

function cyberIsOpen(date = new Date()) {
  const p = chileDateParts(date);
  const day = `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
  return day >= CYBER_UPGRADE.start && day <= CYBER_UPGRADE.end;
}

function cyberNormalize(value) {
  return String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
}

// El negocio pidió limitar la campaña a clientes instalados hasta agosto de 2026 (no ofrecer el
// upgrade a quien recién está empezando el servicio). La "planilla madre" (sincronizada en
// app_state.billingCustomers, no en app_state.customers) trae installationDate por cliente; sin
// ella no había forma de aplicar este corte.
const CYBER_INSTALL_CUTOFF = "2026-08-31";
const CYBER_SPANISH_MONTHS = {
  enero: "01", febrero: "02", marzo: "03", abril: "04", mayo: "05", junio: "06",
  julio: "07", agosto: "08", septiembre: "09", setiembre: "09", octubre: "10", noviembre: "11", diciembre: "12",
};

// installationDate casi siempre viene "YYYY-MM-DD", pero la planilla importada trae al menos un
// caso en español ("24 julio 2026") y otro con un año que no cuadra ("2026-12-17" entre puros
// registros de diciembre de 2025 -- probablemente un typo de digitación, no se corrige a ciegas).
// Sin poder normalizar la fecha, no hay base para decidir el corte, así que se marca como
// "installation_date_unknown" en vez de arriesgar una comparación de texto incorrecta (un string
// no-ISO compara mal contra "2026-08-31" letra por letra).
function cyberParseInstallDate(value) {
  const raw = String(value || "").trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  const match = cyberNormalize(raw).match(/^(\d{1,2})\s+([a-z]+)\s+(\d{4})$/);
  const month = match && CYBER_SPANISH_MONTHS[match[2]];
  return month ? `${match[3]}-${month}-${match[1].padStart(2, "0")}` : null;
}

// La cartera operativa (app_state.customers) nunca tuvo un plan llamado "Oro" ni fecha de
// instalación ni un campo active/status confiable (siempre null, o true incluso para clientes ya
// cortados). "Plan Oro" ($18.000, ver CYBER_UPGRADE) es un precio, no un nombre de plan: en la
// planilla real conviven "BASICO 30MB" (la mayoría, etiqueta heredada de antes de la mejora de
// velocidad) y "BASICO 100MB" al mismo precio -- filtrar por nombre de plan dejaba fuera a la
// mayoría de los clientes de ese nivel. El corte/suspensión real tampoco vive acá: viene de la
// planilla sincronizada que ya usa /api/billing/cortados (ver cortadosPhoneSet).
function cyberCandidates(state, cortadosPhones) {
  const selected = [], excluded = [], seen = new Set();
  for (const b of Array.isArray(state.billingCustomers) ? state.billingCustomers : []) {
    if (Number(b.monthlyAmount) !== 18000) continue;
    const phone = normalizeWhatsAppPhone(b.phone);
    const installDate = cyberParseInstallDate(b.installationDate);
    const reason = !/^569\d{8}$/.test(phone) ? "invalid_phone"
      : cortadosPhones?.has(phone) ? "inactive"
      : !installDate ? "installation_date_unknown"
      : installDate > CYBER_INSTALL_CUTOFF ? "installed_after_cutoff"
      : seen.has(phone) ? "duplicate" : null;
    if (reason) { excluded.push({ id: b.id, reason }); continue; }
    seen.add(phone);
    selected.push({ id: String(b.id || ""), name: String(b.customerName || b.name || ""), phone, plan: String(b.plan || "") });
  }
  return { selected, excluded };
}

// Mismo origen que /api/billing/cortados (ver más abajo), reutilizado acá para no mandar la
// campaña a alguien que el negocio ya cortó por no pago. Si la planilla no responde, se devuelve
// null (no una lista vacía) para no confundir "sin cortados" con "no se pudo verificar".
// Auditoría 2026-10-05: el token de la planilla estaba escrito en el código (y por tanto en el repositorio).
// Ahora se lee de la variable CORTADOS_SYNC_URL si existe; el valor anterior queda solo como respaldo para
// no cortar el servicio hasta que se configure la variable y se rote el token en Google Apps Script.
const CORTADOS_SYNC_URL_FALLBACK = "https://script.google.com/macros/s/AKfycbxQWG6fkP1_V8quAUCGN0q2kDtHq5nT4kmOXjTtqdkP9kBaEx_KoE0KAwnG39QhxJvd/exec?cortados=1&token=bpgo_sheets_sync_2026_seguro";
function cortadosSyncUrl(env) {
  return String(env?.CORTADOS_SYNC_URL || CORTADOS_SYNC_URL_FALLBACK).trim();
}

async function cortadosPhoneSet(env) {
  const syncUrl = cortadosSyncUrl(env);
  const upstream = await fetch(syncUrl, { cache: "no-store" }).catch(() => null);
  const payload = await upstream?.json().catch(() => null);
  if (!upstream?.ok || !payload?.ok || !Array.isArray(payload.cortados)) return null;
  return new Set(payload.cortados.map((value) => normalizeWhatsAppPhone(value)));
}

function cyberButtonAction(message) {
  const payload = message.button?.payload || message.interactive?.button_reply?.id || "";
  const prefix = `${CYBER_UPGRADE.id}:`;
  if (payload.startsWith(prefix)) {
    const action = payload.slice(prefix.length);
    return ["interest", "human", "decline"].includes(action) ? action : "";
  }
  return "";
}

async function ensureCyberTables(env) {
  await ensureWhatsAppCampaignTable(env);
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS whatsapp_upgrade_requests (
    campaign TEXT NOT NULL, phone TEXT NOT NULL, customer_name TEXT, response TEXT,
    source_message_id TEXT UNIQUE, updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (campaign, phone)
  )`).run();
}

async function cyberSnapshot(env) {
  await ensureCyberTables(env);
  const row = await env.DB.prepare("SELECT data FROM app_state WHERE id='main'").first();
  if (!row?.data) throw new Error("No se pudo leer la cartera actual.");
  const cortados = await cortadosPhoneSet(env);
  const candidates = cyberCandidates(JSON.parse(row.data), cortados);
  const sends = await env.DB.prepare(`SELECT c.recipient AS phone, c.message_id, c.created_at,
    r.customer_name, r.response, s.status AS delivery_status
    FROM whatsapp_campaign_sends c
    LEFT JOIN whatsapp_upgrade_requests r ON r.campaign=c.campaign AND r.phone=c.recipient
    LEFT JOIN whatsapp_message_status s ON s.message_id=c.message_id
    WHERE c.campaign=? ORDER BY c.created_at DESC`).bind(CYBER_UPGRADE.id).all();
  const attempted = new Set((sends.results || []).map((x) => x.phone));
  // 2026-10-02: la atención humana YA NO excluye de la campaña (decisión de Carlos). La marca "human"
  // casi siempre es residual (p. ej. 91 comprobantes de pago que nunca se desmarcan), y excluirla dejaba
  // fuera ~93 de ~241 clientes. Se sigue informando cuántos están en ese modo, solo como dato.
  const human = await env.DB.prepare("SELECT phone FROM whatsapp_bot_sessions WHERE mode='human'").all();
  const held = new Set((human.results || []).map((x) => x.phone));
  const eligible = candidates.selected.filter((x) => !attempted.has(x.phone));
  const fingerprint = JSON.stringify(eligible.map((x) => [x.id, x.phone, x.plan]).sort());
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(fingerprint));
  const previewId = Array.from(new Uint8Array(digest), (x) => x.toString(16).padStart(2, "0")).join("");
  return { campaign: CYBER_UPGRADE, open: cyberIsOpen(), eligible, excluded: candidates.excluded,
    humanExcluded: 0, humanIncluded: eligible.filter((x) => held.has(x.phone)).length, sends: sends.results || [], previewId,
    cortadosCheckFailed: cortados === null };
}

function cyberTemplateDefinition(headerHandle, variant = "image") {
  const v = CYBER_TEMPLATE_VARIANTS[variant] || CYBER_TEMPLATE_VARIANTS.image;
  return { name: v.template, language: CYBER_UPGRADE.language, category: "MARKETING",
    components: [...(v.header ? [{ type: "HEADER", format: "IMAGE", example: { header_handle: [headerHandle] } }] : []),
      { type: "BODY", text: v.text },
      { type: "BUTTONS", buttons: CYBER_UPGRADE.buttons.map((text) => ({ type: "QUICK_REPLY", text })) }] };
}

// Meta exige un media handle (no un link directo) como ejemplo al CREAR una plantilla con header
// de imagen, obtenido con su API de carga reanudable (2 pasos: abrir sesión, subir bytes). El
// link público (CYBER_UPGRADE.bannerPath) sigue sirviendo para el ENVÍO real de cada mensaje --
// esto solo es para que el equipo de revisión de Meta vea la imagen de ejemplo.
async function uploadCyberBannerToMeta(env, origin, credentials) {
  const appId = String(env.META_APP_ID || "").trim();
  if (!appId) throw new Error("Falta META_APP_ID para subir el banner a Meta.");
  const imageResponse = await fetch(`${origin}${CYBER_UPGRADE.bannerPath}`);
  if (!imageResponse.ok) throw new Error("No se pudo leer el banner publicado en el sitio.");
  const bytes = await imageResponse.arrayBuffer();
  const startRes = await fetch(`https://graph.facebook.com/v21.0/${appId}/uploads?file_length=${bytes.byteLength}&file_type=image/png&access_token=${encodeURIComponent(credentials.accessToken)}`,
    { method: "POST" });
  const startData = await startRes.json().catch(() => ({}));
  if (!startRes.ok || !startData.id) throw new Error("Meta rechazó iniciar la carga del banner.");
  const uploadRes = await fetch(`https://graph.facebook.com/v21.0/${startData.id}`, {
    method: "POST",
    headers: { authorization: `OAuth ${credentials.accessToken}`, "file_offset": "0" },
    body: bytes,
  });
  const uploadData = await uploadRes.json().catch(() => ({}));
  if (!uploadRes.ok || !uploadData.h) throw new Error("Meta rechazó la carga del banner.");
  return uploadData.h;
}

async function cyberTemplateVariant(env, variant, create = false, origin = "") {
  const v = CYBER_TEMPLATE_VARIANTS[variant];
  const c = await getWhatsAppCredentials(env);
  if (!c.accessToken || !c.wabaId) throw new Error("Falta la conexión con Meta.");
  const endpoint = `https://graph.facebook.com/v25.0/${encodeURIComponent(c.wabaId)}/message_templates`;
  const headers = { authorization: `Bearer ${c.accessToken}`, "content-type": "application/json" };
  const res = await fetch(`${endpoint}?name=${v.template}&fields=name,status,language,category,components`, { headers });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error("No se pudo consultar la plantilla en Meta.");
  const found = (data.data || []).find((x) => x.name === v.template && x.language === CYBER_UPGRADE.language);
  if (found) {
    const body = found.components?.find((x) => x.type === "BODY")?.text;
    const buttons = found.components?.find((x) => x.type === "BUTTONS")?.buttons || [];
    const header = found.components?.find((x) => x.type === "HEADER");
    const matches = body === v.text && found.category === "MARKETING"
      && buttons.length === 3 && buttons.every((x, i) => x.type === "QUICK_REPLY" && x.text === CYBER_UPGRADE.buttons[i])
      && (v.header ? header?.format === "IMAGE" : !header);
    return { variant, name: v.template, status: found.status, matches, ready: found.status === "APPROVED" && matches };
  }
  if (!create) return { variant, name: v.template, status: "NOT_FOUND", matches: false, ready: false };
  const headerHandle = v.header ? await uploadCyberBannerToMeta(env, origin, c) : null;
  const result = await fetch(endpoint, { method: "POST", headers, body: JSON.stringify(cyberTemplateDefinition(headerHandle, variant)) });
  if (!result.ok) {
    const detail = await result.json().catch(() => ({}));
    throw new Error(`Meta no aceptó la creación de la plantilla${detail?.error?.error_user_msg ? `: ${detail.error.error_user_msg}` : "."}`);
  }
  return { variant, name: v.template, status: "PENDING", matches: true, ready: false };
}

// Estado combinado: `ready` si CUALQUIERA de las dos variantes está aprobada; `variant` es la que se
// usará para enviar (la de imagen tiene prioridad si ambas están listas).
async function cyberTemplate(env, create = false, origin = "", variant = "image") {
  if (create) return cyberTemplateVariant(env, variant === "text" ? "text" : "image", true, origin);
  const image = await cyberTemplateVariant(env, "image", false, origin).catch(() => ({ variant: "image", status: "UNAVAILABLE", matches: false, ready: false }));
  const text = await cyberTemplateVariant(env, "text", false, origin).catch(() => ({ variant: "text", status: "UNAVAILABLE", matches: false, ready: false }));
  const active = image.ready ? image : text.ready ? text : null;
  return { ...(active || image), ready: Boolean(active), activeVariant: active?.variant || null, variants: { image, text } };
}

async function sendCyberCampaign(env, body, origin = "") {
  if (!cyberIsOpen()) throw new Error("La promoción no está vigente.");
  if (body.confirm !== CYBER_UPGRADE.id) throw new Error("Confirma la campaña antes de enviar.");
  const snapshot = await cyberSnapshot(env);
  if (snapshot.cortadosCheckFailed) throw new Error("No se pudo verificar la lista de clientes cortados. Intenta de nuevo en unos minutos.");
  if (body.previewId !== snapshot.previewId) throw new Error("La cartera cambió. Actualiza y revisa la selección.");
  const phones = Array.isArray(body.phones) ? [...new Set(body.phones)] : [];
  if (!phones.length || phones.length > 20) throw new Error("Selecciona entre 1 y 20 destinatarios por lote.");
  const eligible = new Map(snapshot.eligible.map((x) => [x.phone, x]));
  if (phones.some((phone) => !eligible.has(phone))) throw new Error("Hay destinatarios que ya no son elegibles.");
  const approved = await cyberTemplate(env, false, origin);
  if (!approved.ready) throw new Error("La plantilla debe estar aprobada y coincidir con la oferta.");
  const sendVariant = CYBER_TEMPLATE_VARIANTS[approved.activeVariant];
  const credentials = await getWhatsAppCredentials(env);
  if (!credentials.phoneNumberId || !credentials.accessToken) throw new Error("WhatsApp no está configurado.");
  const results = [];
  for (const phone of phones) {
    if (!cyberIsOpen()) {
      results.push({ phone, status: "skipped" }); continue;
    }
    // Claim before network I/O: concurrent batches and ambiguous timeouts must never resend.
    const claim = await env.DB.prepare("INSERT OR IGNORE INTO whatsapp_campaign_sends (campaign,recipient) VALUES (?,?)")
      .bind(CYBER_UPGRADE.id, phone).run();
    if (!claim.meta?.changes) { results.push({ phone, status: "skipped" }); continue; }
    try {
      const response = await fetch(`https://graph.facebook.com/v25.0/${encodeURIComponent(credentials.phoneNumberId)}/messages`, {
        method: "POST", headers: { authorization: `Bearer ${credentials.accessToken}`, "content-type": "application/json" },
        body: JSON.stringify({ messaging_product: "whatsapp", to: phone, type: "template",
          template: { name: sendVariant.template, language: { code: CYBER_UPGRADE.language },
            components: [
              ...(sendVariant.header ? [{ type: "header", parameters: [{ type: "image", image: { link: `${origin}${CYBER_UPGRADE.bannerPath}` } }] }] : []),
              ...["interest", "human", "decline"].map((action, i) => ({ type: "button", sub_type: "quick_reply", index: String(i),
                parameters: [{ type: "payload", payload: `${CYBER_UPGRADE.id}:${action}` }] })),
            ] } }),
      });
      const data = await response.json().catch(() => ({}));
      const messageId = response.ok && data.messages?.[0]?.id;
      if (!messageId) { results.push({ phone, status: "review_required" }); continue; }
      await env.DB.prepare("UPDATE whatsapp_campaign_sends SET message_id=? WHERE campaign=? AND recipient=?")
        .bind(messageId, CYBER_UPGRADE.id, phone).run();
      await saveWhatsAppStatus(env, { messageId, recipient: phone, status: "accepted" });
      await env.DB.prepare(`INSERT OR IGNORE INTO whatsapp_inbox_messages
        (message_id,phone,direction,message_type,message_text,created_at) VALUES (?,?,'outbound','template',?,?)`)
        .bind(messageId, phone, sendVariant.text, new Date().toISOString()).run();
      await env.DB.prepare("INSERT OR IGNORE INTO whatsapp_upgrade_requests (campaign,phone,customer_name) VALUES (?,?,?)")
        .bind(CYBER_UPGRADE.id, phone, eligible.get(phone).name).run();
      results.push({ phone, status: "accepted" });
    } catch { results.push({ phone, status: "review_required" }); }
  }
  return { ok: results.every((x) => x.status !== "review_required"), results };
}

async function handleCyberReply(env, credentials, message) {
  const action = cyberButtonAction(message);
  if (!action) return false;
  // Los clientes en atención humana también reciben la campaña, así que su botón se procesa igual:
  // antes se descartaba en silencio y Carlos nunca se enteraba de que el cliente había respondido.
  const alreadyHuman = await getBotSessionMode(env, message.from) === "human";
  await ensureCyberTables(env);
  const sent = await env.DB.prepare("SELECT message_id FROM whatsapp_campaign_sends WHERE campaign=? AND recipient=?")
    .bind(CYBER_UPGRADE.id, message.from).first();
  if (!sent?.message_id || (message.context?.id && message.context.id !== sent.message_id)) return true;
  // A request arriving after the offer closes is referred without promising the price.
  const response = action === "decline" ? "declined" : !cyberIsOpen() ? "expired" : action === "human" ? "human" : "interested";
  const previous = await env.DB.prepare("SELECT response, customer_name FROM whatsapp_upgrade_requests WHERE campaign=? AND phone=?")
    .bind(CYBER_UPGRADE.id, message.from).first();
  if (previous?.response === "converted" || previous?.response === response) return true;
  await env.DB.prepare(`INSERT INTO whatsapp_upgrade_requests (campaign,phone,response,source_message_id)
    VALUES (?,?,?,?) ON CONFLICT(campaign,phone) DO UPDATE SET response=excluded.response,
    source_message_id=excluded.source_message_id, updated_at=datetime('now')`)
    .bind(CYBER_UPGRADE.id, message.from, response, message.id).run();
  if (response === "declined") {
    if (!alreadyHuman)
      await sendWhatsAppText(env, credentials, message.from, "Entendido, no seguimos con esta promoción.");
  } else {
    // Igual que con los comprobantes de pago: un aviso de WhatsApp a Carlos (misma plantilla
    // "aviso_nuevo_caso"), no solo el cambio de modo, porque de lo contrario nadie se entera
    // de que el cliente pidió el upgrade o quiere hablar con un ejecutivo.
    const summary = response === "interested"
      ? "Cliente presionó 'Me interesa' en la campaña Cyber Oro→Platino. Solicita el cambio de plan."
      : response === "human"
      ? "Cliente presionó 'Hablar con ejecutivo' en la campaña Cyber Oro→Platino."
      : "Cliente respondió a la campaña Cyber Oro→Platino fuera de plazo (después del 5 de octubre). No se le prometió el precio promocional.";
    await notifyStaff(env, credentials, "carlos", "Campaña Cyber BP GO", previous?.customer_name, message.from, summary, { sourceMessageId: message.id });
    // Acuse al cliente (2026-10-03): antes quien presionaba "Me interesa" no recibía nada y quedaba en
    // silencio hasta que Carlos lo viera. Es texto libre dentro de la ventana de 24 h (el cliente
    // acaba de escribir), así que no depende de plantillas ni de la facturación de Meta. Nunca promete
    // el precio fuera de plazo. La protección contra repetición es el chequeo previous.response arriba.
    const ack = response === "interested"
      ? "¡Excelente! 🎉 Recibimos tu solicitud para mejorar al *Plan Platino 300 Mb/s* con 12% de descuento ($21.990/mes durante 6 meses). Un ejecutivo de BP GO te contactará por este mismo medio para coordinar el cambio. 🙌"
      : response === "human"
      ? "¡Claro! Ya avisé a un ejecutivo de BP GO para que te responda por este mismo medio en breve. 🙏"
      : "Gracias por escribirnos. La promoción Cyber ya terminó; un ejecutivo de BP GO revisará tu caso y te contactará por este mismo medio. 🙏";
    await sendWhatsAppText(env, credentials, message.from, ack).catch(() => null);
    // Si ya estaba con un agente se respeta el motivo original de esa conversación.
    if (!alreadyHuman) await setBotSessionMode(env, message.from, "human", `cyber_upgrade_${response}`);
  }
  return true;
}

// Un cliente con factibilidad YA confirmada (esperando elegir plan, o esperando mandar sus datos
// de instalación) es el lead más valioso del embudo de venta -- si Carlos no nota que quedó sin
// responder, se puede "escapar" sin que nadie se entere. Corre cada 10 minutos (ver
// sales-lead-followup.yml) y manda UN recordatorio al cliente + un aviso a Carlos, una sola vez
// por lead (nunca repetido, para no ser invasivo) cuando pasan 20 minutos sin ningún mensaje
// entrante de ese teléfono. Se compara contra el último mensaje ENTRANTE real (no contra
// updated_at del lead), porque un mensaje que no logra completar el campo pedido no actualiza
// updated_at pero sí demuestra que el cliente sigue ahí.
const SALES_LEAD_FOLLOWUP_AFTER_MS = 20 * 60 * 1000;
const SALES_LEAD_FOLLOWUP_STATUSES = ["awaiting_plan", "awaiting_installation_data"];

async function ensureSalesLeadFollowupColumn(env) {
  await env.DB.prepare("ALTER TABLE whatsapp_sales_leads ADD COLUMN followup_sent_at TEXT").run().catch(() => null);
}

async function followUpStaleSalesLeads(env) {
  await ensureWhatsAppBotTables(env);
  await ensureSalesLeadFollowupColumn(env);
  const credentials = await getWhatsAppCredentials(env);
  if (!credentials.phoneNumberId || !credentials.accessToken) return { ok: false, error: "WhatsApp no está configurado." };
  const placeholders = SALES_LEAD_FOLLOWUP_STATUSES.map(() => "?").join(",");
  const leads = await env.DB.prepare(`SELECT * FROM whatsapp_sales_leads
    WHERE status IN (${placeholders}) AND followup_sent_at IS NULL ORDER BY updated_at ASC LIMIT 50`)
    .bind(...SALES_LEAD_FOLLOWUP_STATUSES).all();
  const results = [];
  for (const lead of (leads.results || [])) {
    if (await getBotSessionMode(env, lead.phone) === "human") continue;
    const lastInbound = await env.DB.prepare(`SELECT created_at FROM whatsapp_inbox_messages
      WHERE phone=? AND direction='inbound' ORDER BY created_at DESC LIMIT 1`).bind(lead.phone).first();
    const lastActivity = lastInbound?.created_at ? Date.parse(lastInbound.created_at) : Date.parse(lead.updated_at);
    if (Date.now() - lastActivity < SALES_LEAD_FOLLOWUP_AFTER_MS) continue;
    // Claim antes de mandar nada: si dos ejecuciones se solaparan, solo una debe notificar.
    const claim = await env.DB.prepare("UPDATE whatsapp_sales_leads SET followup_sent_at=datetime('now') WHERE id=? AND followup_sent_at IS NULL").bind(lead.id).run();
    if (!claim.meta?.changes) continue;
    const message = lead.status === "awaiting_plan"
      ? "¡Hola! 😊 Vimos que no alcanzaste a responder -- ¿tienes alguna duda sobre los planes que te enviamos? Avísanos y seguimos cuando quieras. 🙌"
      : "¡Hola! 😊 Nos falta que nos envíes tus datos para coordinar la instalación. ¿Seguimos? Cualquier duda, avísanos. 🙌";
    await sendWhatsAppText(env, credentials, lead.phone, message).catch(() => null);
    await notifyStaff(env, credentials, "carlos", "Seguimiento de venta", lead.installation_name || lead.customer_name, lead.phone,
      `Cliente con factibilidad confirmada sin respuesta hace más de 20 minutos (estado: ${lead.status}). Sector: ${lead.sector || "no indicado"}.`,
      { sourceMessageId: `followup-${lead.id}` });
    results.push(lead.id);
  }
  return { ok: true, followedUp: results.length };
}

// El 2026-10-01 Meta aceptó el envío (message_id) pero el delivery real falló para TODOS los
// mensajes de este lote con "Business eligibility payment issue" (cuenta con pago pendiente) --
// cyberSnapshot excluye como "ya intentado" cualquier teléfono con una fila en
// whatsapp_campaign_sends sin importar si falló, así que sin esto esos clientes quedaban
// marcados como intentados para siempre aunque nunca recibieron el mensaje. Esto borra la marca
// SOLO de los que Meta confirmó como 'failed' (nunca de los 'accepted'/sin estado aún, que si
// llegaron o están en camino), para que vuelvan a aparecer como elegibles.
async function retryCyberFailed(env) {
  await ensureCyberTables(env);
  const rows = await env.DB.prepare(`SELECT c.recipient FROM whatsapp_campaign_sends c
    JOIN whatsapp_message_status s ON s.message_id = c.message_id
    WHERE c.campaign=? AND s.status='failed'`).bind(CYBER_UPGRADE.id).all();
  const recipients = (rows.results || []).map((x) => x.recipient);
  for (const recipient of recipients) {
    await env.DB.prepare("DELETE FROM whatsapp_campaign_sends WHERE campaign=? AND recipient=?")
      .bind(CYBER_UPGRADE.id, recipient).run();
  }
  return { ok: true, freed: recipients.length };
}

async function handleCyberApi(request, env, session) {
  if (session?.role !== "super_admin") return Response.json({ ok: false, error: "Sin autorización." }, { status: 403 });
  try {
    await ensureWhatsAppStatusTable(env);
    await ensureWhatsAppInboxTable(env);
    await ensureWhatsAppBotTables(env);
    await ensureCyberTables(env);
    const origin = new URL(request.url).origin;
    if (request.method === "GET") {
      const snapshot = await cyberSnapshot(env);
      const template = await cyberTemplate(env, false, origin).catch(() => ({ status: "UNAVAILABLE", ready: false }));
      return Response.json({ ...snapshot, template }, { headers: { "cache-control": "no-store" } });
    }
    const body = await request.json();
    if (request.method === "POST" && body.action === "template") return Response.json(await cyberTemplate(env, true, origin, body.variant === "text" ? "text" : "image"));
    if (request.method === "POST" && body.action === "send") return Response.json(await sendCyberCampaign(env, body, origin));
    if (request.method === "POST" && body.action === "retryFailed") return Response.json(await retryCyberFailed(env));
    if (request.method === "PATCH" && body.action === "converted") {
      const result = await env.DB.prepare(`UPDATE whatsapp_upgrade_requests SET response='converted', updated_at=datetime('now')
        WHERE campaign=? AND phone=? AND response='interested'`).bind(CYBER_UPGRADE.id, String(body.phone || "")).run();
      return Response.json({ ok: Boolean(result.meta?.changes) });
    }
    return Response.json({ ok: false, error: "Operación no disponible." }, { status: 400 });
  } catch (error) {
    // Antes era un mensaje genérico fijo -- con la carga del banner a Meta de por medio (nueva
    // fuente de fallos: META_APP_ID faltante, banner no accesible, Meta rechazando la subida) hace
    // falta ver el error real para poder diagnosticar, no solo "algo salió mal".
    return Response.json({ ok: false, error: error?.message || "No se pudo completar la operación. Actualiza la campaña y verifica vigencia, selección y aprobación de Meta." }, { status: 409 });
  }
}


async function sendBillingMessages(request, env) {
  const body = await request.json().catch(() => ({}));
  const records = Array.isArray(body.records) ? body.records.slice(0, 50) : [];
  if (!records.length) {
    return Response.json({ ok: false, error: "No hay destinatarios para enviar." }, { status: 400 });
  }

  const credentials = await getWhatsAppCredentials(env);
  const accessToken = credentials.accessToken;
  const phoneNumberId = credentials.phoneNumberId;
  const campaign = body.campaign === "number-change" ? "number-change" : "billing";
  const templateName = campaign === "number-change"
    ? "nuevo_numero_whatsapp"
    : String(env.WHATSAPP_TEMPLATE_NAME || "recordatorio_pago_bpgo").trim();
  const languageCode = String(env.WHATSAPP_TEMPLATE_LANGUAGE || "es_CL").trim();
  if (!accessToken || !phoneNumberId || !templateName || !languageCode) {
    return Response.json({ ok: false, error: "Configuracion de WhatsApp incompleta." }, { status: 500 });
  }

  const endpoint = `https://graph.facebook.com/v25.0/${encodeURIComponent(phoneNumberId)}/messages`;
  const results = [];
  if (campaign === "number-change") await ensureWhatsAppCampaignTable(env);
  // La campaña "billing" (usada desde la cola de "Gestión diaria") no tenía ningún control de
  // duplicados -- reprocesar la cola o hacer doble clic reenviaba el mismo recordatorio al mismo
  // cliente el mismo día. Se limita a un envío por teléfono por día (hora Chile); días distintos sí
  // pueden reenviar (recordatorios sucesivos mientras la deuda siga pendiente).
  if (campaign === "billing") await ensureManualBillingSendsTable(env);
  const chileToday = chileDateParts();
  const todayKey = `${chileToday.year}-${String(chileToday.month).padStart(2, "0")}-${String(chileToday.day).padStart(2, "0")}`;
  for (const record of records) {
    const phone = normalizeWhatsAppPhone(record.phone);
    if (!phone) {
      results.push({ id: record.id, phone, ok: false, error: "Telefono invalido" });
      continue;
    }
    if (campaign === "number-change") {
      const previous = await env.DB.prepare("SELECT message_id FROM whatsapp_campaign_sends WHERE campaign = ? AND recipient = ?")
        .bind(campaign, phone).first();
      if (previous) {
        results.push({ id: record.id, phone, ok: true, skipped: true, messageId: previous.message_id });
        continue;
      }
    }
    if (campaign === "billing") {
      const previous = await env.DB.prepare("SELECT message_id FROM whatsapp_manual_billing_sends WHERE phone = ? AND send_date = ?")
        .bind(phone, todayKey).first();
      if (previous) {
        results.push({ id: record.id, phone, ok: true, skipped: true, messageId: previous.message_id });
        continue;
      }
    }
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: phone,
        type: "template",
        template: { name: templateName, language: { code: languageCode } },
      }),
    });
    const meta = await response.json().catch(() => ({}));
    const messageId = meta.messages?.[0]?.id;
    if (messageId) {
      await saveWhatsAppStatus(env, { messageId, recipient: phone, status: "accepted" }).catch(() => null);
      if (campaign === "number-change") {
        await env.DB.prepare("INSERT OR IGNORE INTO whatsapp_campaign_sends (campaign, recipient, message_id) VALUES (?, ?, ?)")
          .bind(campaign, phone, messageId).run();
      }
      if (campaign === "billing") {
        await env.DB.prepare("INSERT OR IGNORE INTO whatsapp_manual_billing_sends (phone, send_date, message_id) VALUES (?, ?, ?)")
          .bind(phone, todayKey, messageId).run();
      }
    }
    results.push({
      id: record.id,
      phone,
      ok: response.ok,
      messageId,
      error: response.ok ? undefined : (meta.error?.message || "Error al enviar por WhatsApp"),
      errorCode: response.ok ? undefined : meta.error?.code,
    });
  }
  const sent = results.filter((item) => item.ok && !item.skipped).length;
  const skipped = results.filter((item) => item.skipped).length;
  const failed = results.filter((item) => !item.ok).length;
  return Response.json({ ok: failed === 0, sent, skipped, failed, campaign, templateName, results });
}

function toBase64Url(value) {
  return btoa(String.fromCharCode(...new Uint8Array(value))).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

async function signSession(payload, secret) {
  const body = toBase64Url(encoder.encode(JSON.stringify(payload)));
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(body));
  return body + "." + toBase64Url(signature);
}

async function readSession(request, secret) {
  const token = String(request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const expected = await signSession(JSON.parse(atob(parts[0].replace(/-/g, "+").replace(/_/g, "/"))), secret).catch(() => "");
  if (expected !== token) return null;
  const payload = JSON.parse(atob(parts[0].replace(/-/g, "+").replace(/_/g, "/")));
  return payload.exp > Date.now() ? payload : null;
}

// Generalizado desde la verificación original (solo cobranza) para que el nuevo seguimiento de
// leads de venta pueda reusar exactamente la misma validación OIDC (firma RS256 contra el JWKS de
// GitHub + claims de repo/rama/workflow) en vez de duplicar todo este bloque por cada automatización.
async function verifyGithubActionsOidc(request, { audience, workflowPath }) {
  const token = String(request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  let header;
  let claims;
  try {
    header = JSON.parse(new TextDecoder().decode(fromBase64Url(parts[0])));
    claims = JSON.parse(new TextDecoder().decode(fromBase64Url(parts[1])));
  } catch { return null; }
  if (header.alg !== "RS256" || !header.kid) return null;
  const jwksResponse = await fetch("https://token.actions.githubusercontent.com/.well-known/jwks").catch(() => null);
  const jwks = jwksResponse ? await jwksResponse.json().catch(() => ({})) : {};
  const jwk = Array.isArray(jwks.keys) ? jwks.keys.find((item) => item.kid === header.kid && item.kty === "RSA") : null;
  if (!jwk) return null;
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]).catch(() => null);
  if (!key) return null;
  const validSignature = await crypto.subtle.verify({ name: "RSASSA-PKCS1-v1_5" }, key, fromBase64Url(parts[2]), encoder.encode(`${parts[0]}.${parts[1]}`)).catch(() => false);
  const now = Math.floor(Date.now() / 1000);
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  const validClaims = claims.iss === "https://token.actions.githubusercontent.com"
    && aud.includes(audience)
    && claims.repository === "bpgo12/bpgo-operaciones"
    && claims.ref === "refs/heads/main"
    && ["schedule", "workflow_dispatch", "workflow_run"].includes(claims.event_name)
    && claims.workflow_ref === `bpgo12/bpgo-operaciones/.github/workflows/${workflowPath}@refs/heads/main`
    && Number(claims.exp) > now && Number(claims.iat) <= now + 60 && (!claims.nbf || Number(claims.nbf) <= now + 60);
  return validSignature && validClaims ? claims : null;
}

async function verifyBillingAutomationOidc(request) {
  return verifyGithubActionsOidc(request, { audience: "bpgo-billing-automation", workflowPath: "billing-automation.yml" });
}

async function verifySalesFollowUpOidc(request) {
  return verifyGithubActionsOidc(request, { audience: "bpgo-sales-followup", workflowPath: "sales-lead-followup.yml" });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/api/whatsapp/cyber-upgrade") {
      const session = await readSession(request, env.OPERATIONS_ADMIN_SECRET).catch(() => null);
      return handleCyberApi(request, env, session);
    }

    if (url.pathname === "/api/auth" && request.method === "POST") {
      const body = await request.json().catch(() => ({}));
      const email = String(body.email || "").trim().toLowerCase();
      const password = String(body.password || "");
      const row = await env.DB.prepare("SELECT data FROM app_state WHERE id = 'main'").first();
      const state = row ? JSON.parse(row.data) : null;
      const user = state && Array.isArray(state.users)
        ? state.users.find((item) => String(item.email || "").trim().toLowerCase() === email && String(item.password || "") === password && item.active !== false)
        : null;
      const token = user ? await signSession({ userId: user.id, role: user.role, exp: Date.now() + 12 * 60 * 60 * 1000 }, env.OPERATIONS_ADMIN_SECRET) : null;
      return Response.json(user ? { ok: true, userId: user.id, token } : { ok: false }, { status: user ? 200 : 401 });
    }

    if (url.pathname === "/api/user-password" && request.method === "PUT") {
      const session = await readSession(request, env.OPERATIONS_ADMIN_SECRET);
      if (!session || session.role !== "super_admin") return Response.json({ ok: false }, { status: 403 });
      const body = await request.json().catch(() => ({}));
      const email = String(body.email || "").trim().toLowerCase();
      const password = String(body.password || "").trim();
      if (!email || !password) return Response.json({ ok: false }, { status: 400 });
      const row = await env.DB.prepare("SELECT data FROM app_state WHERE id = 'main'").first();
      const state = row ? JSON.parse(row.data) : null;
      let found = false;
      if (!state || !Array.isArray(state.users)) return Response.json({ ok: false }, { status: 500 });
      state.users = state.users.map((user) => {
        if (String(user.email || "").trim().toLowerCase() !== email) return user;
        found = true;
        return { ...user, password };
      });
      if (!found) return Response.json({ ok: false }, { status: 404 });
      await env.DB.prepare("UPDATE app_state SET data = ?, updated_at = datetime('now') WHERE id = 'main'")
        .bind(JSON.stringify(state)).run();
      return Response.json({ ok: true });
    }

    if (url.pathname === "/api/user-password" && request.method === "GET") {
      const session = await readSession(request, env.OPERATIONS_ADMIN_SECRET);
      if (!session || session.role !== "super_admin") return Response.json({ ok: false }, { status: 403 });
      const email = String(url.searchParams.get("email") || "").trim().toLowerCase();
      const row = await env.DB.prepare("SELECT data FROM app_state WHERE id = 'main'").first();
      const state = row ? JSON.parse(row.data) : null;
      const user = state && Array.isArray(state.users)
        ? state.users.find((item) => String(item.email || "").trim().toLowerCase() === email)
        : null;
      if (!user) return Response.json({ ok: false }, { status: 404 });
      return Response.json({ ok: true, password: String(user.password || "") });
    }

    if (url.pathname === "/api/user" && request.method === "DELETE") {
      const session = await readSession(request, env.OPERATIONS_ADMIN_SECRET);
      if (!session || session.role !== "super_admin") return Response.json({ ok: false, error: "Sin autorización" }, { status: 403 });
      const body = await request.json().catch(() => ({}));
      const email = String(body.email || "").trim().toLowerCase();
      const row = await env.DB.prepare("SELECT data FROM app_state WHERE id = 'main'").first();
      const state = row ? JSON.parse(row.data) : null;
      if (!state || !Array.isArray(state.users) || !email) return Response.json({ ok: false, error: "Usuario inválido" }, { status: 400 });
      const user = state.users.find((item) => String(item.email || "").trim().toLowerCase() === email);
      if (!user) return Response.json({ ok: false, error: "Usuario no encontrado" }, { status: 404 });
      if (String(user.id) === String(session.userId)) return Response.json({ ok: false, error: "No puedes eliminar tu propia sesión" }, { status: 409 });
      state.users = state.users.filter((item) => String(item.id) !== String(user.id));
      if (Array.isArray(state.workOrders)) {
        state.workOrders = state.workOrders.map((work) => {
          const next = { ...work };
          if (Array.isArray(next.assignedToIds)) next.assignedToIds = next.assignedToIds.filter((id) => String(id) !== String(user.id));
          if (String(next.assignedToId || "") === String(user.id)) delete next.assignedToId;
          if (String(next.technicianId || "") === String(user.id)) delete next.technicianId;
          return next;
        });
      }
      ["technicianShifts", "shifts"].forEach((key) => {
        if (Array.isArray(state[key])) state[key] = state[key].filter((item) => String(item.userId || item.technicianId || "") !== String(user.id));
      });
      await env.DB.prepare("UPDATE app_state SET data = ?, updated_at = datetime('now') WHERE id = 'main'")
        .bind(JSON.stringify(state)).run();
      return Response.json({ ok: true, deletedUserId: user.id });
    }

    if (url.pathname === "/api/state" && request.method === "PUT") {
      const session = await readSession(request, env.OPERATIONS_ADMIN_SECRET);
      if (!session) return Response.json({ ok: false }, { status: 401 });
      const body = await request.json().catch(() => ({}));
      const incoming = body.data;
      const row = await env.DB.prepare("SELECT data FROM app_state WHERE id = 'main'").first();
      const current = row ? JSON.parse(row.data) : null;
      if (incoming && Array.isArray(incoming.users) && current && Array.isArray(current.users)) {
        incoming.users = incoming.users.map((user) => {
          if (String(user.password || "").trim() && user.password !== MASKED_PASSWORD) return user;
          const saved = current.users.find((item) => item.id === user.id || String(item.email || "").toLowerCase() === String(user.email || "").toLowerCase());
          return saved ? { ...user, password: saved.password || "" } : user;
        });
      }
      if (!incoming) return Response.json({ ok: false }, { status: 400 });
      await env.DB.prepare("UPDATE app_state SET data = ?, updated_at = datetime('now') WHERE id = 'main'")
        .bind(JSON.stringify(incoming)).run();
      return Response.json({ ok: true });
    }

    if (url.pathname === "/api/state" && request.method === "GET") {
      const session = await readSession(request, env.OPERATIONS_ADMIN_SECRET);
      if (!session) return Response.json({ ok: false, error: "Sesion no autorizada." }, { status: 401 });
      const row = await env.DB.prepare("SELECT data FROM app_state WHERE id = 'main'").first();
      const state = row ? JSON.parse(row.data) : null;
      if (state && Array.isArray(state.users)) {
        state.users = state.users.map((user) => ({ ...user, password: MASKED_PASSWORD }));
      }
      return Response.json({ data: state });
    }

    if (url.pathname === "/api/billing/cortados" && request.method === "GET") {
      const session = await readSession(request, env.OPERATIONS_ADMIN_SECRET);
      if (!session) return Response.json({ ok: false, error: "Sesion no autorizada." }, { status: 401 });
      const syncUrl = cortadosSyncUrl(env);
      const upstream = await fetch(syncUrl, { cache: "no-store" }).catch(() => null);
      const payload = await upstream?.json().catch(() => null);
      if (!upstream?.ok || !payload?.ok) {
        return Response.json({ ok: false, error: "No se pudo consultar la planilla de clientes cortados." }, { status: 502 });
      }
      return Response.json({ ok: true, phones: Array.isArray(payload.cortados) ? payload.cortados : [] });
    }

    if (url.pathname === "/api/whatsapp/webhook" && request.method === "GET") {
      const mode = url.searchParams.get("hub.mode");
      const token = url.searchParams.get("hub.verify_token");
      const challenge = url.searchParams.get("hub.challenge");
      if (mode === "subscribe" && token && token === env.WHATSAPP_WEBHOOK_SECRET) {
        return new Response(challenge || "", {
          status: 200,
          headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
        });
      }
      return new Response("Webhook verification rejected", { status: 403 });
    }

    if (url.pathname === "/api/whatsapp/webhook" && request.method === "POST") {
      const rawBody = await request.text();
      if (env.META_APP_SECRET) {
        const signature = String(request.headers.get("x-hub-signature-256") || "").replace(/^sha256=/i, "");
        const key = await crypto.subtle.importKey("raw", encoder.encode(String(env.META_APP_SECRET)), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
        const expected = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(rawBody)));
        const received = /^[a-f0-9]{64}$/i.test(signature) ? Uint8Array.from(signature.match(/.{2}/g), (byte) => parseInt(byte, 16)) : new Uint8Array();
        if (!equalBytes(received, expected)) {
          return Response.json({ ok: false, error: "Firma de Meta inválida." }, { status: 401 });
        }
      }
      const body = (() => { try { return JSON.parse(rawBody || "{}"); } catch { return {}; } })();
      const changes = Array.isArray(body.entry)
        ? body.entry.flatMap((entry) => Array.isArray(entry.changes) ? entry.changes : [])
        : [];
      // Auditoría 2026-10-05: la firma de Meta solo se exige si META_APP_SECRET está configurado (si no, el
      // webhook acepta cualquier POST). Sin firma verificada, alguien podría falsificar el botón
      // "Registrar pago" de un teléfono de staff y marcar pagos como pagados. Mientras no haya secreto, esas
      // acciones con dinero se descartan en vez de ejecutarse; el resto del bot sigue funcionando igual.
      if (!env.META_APP_SECRET) {
        const staffPhones = new Set([env.STAFF_PHONE_CARLOS, env.STAFF_PHONE_EDUARDO].map((value) => normalizeWhatsAppPhone(value)).filter(Boolean));
        for (const change of changes) {
          if (!Array.isArray(change.value?.messages)) continue;
          change.value.messages = change.value.messages.filter((message) => {
            const forgedPaymentAction = staffPhones.has(normalizeWhatsAppPhone(message.from)) && String(message.button?.payload || "").startsWith("confirm_payment:");
            if (forgedPaymentAction) console.error("unsigned_webhook_payment_action_dropped", message.id);
            return !forgedPaymentAction;
          });
        }
      }
      const statuses = changes.flatMap((change) => Array.isArray(change.value?.statuses) ? change.value.statuses : []);
      for (const item of statuses) {
        if (!item.id || !item.status) continue;
        await saveWhatsAppStatus(env, {
          messageId: item.id,
          recipient: item.recipient_id,
          status: item.status,
          error: item.errors?.[0] || null,
        }).catch(() => null);
        await updateStaffNotificationStatus(env, {
          messageId: item.id,
          status: item.status,
          error: item.errors?.[0] || null,
        }).catch(() => null);
        await updateBillingAutomationStatus(env, {
          messageId: item.id,
          status: item.status,
          error: item.errors?.[0] || null,
        }).catch(() => null);
      }
      const manualEchoesSaved = await saveManualWhatsAppEchoes(env, changes).catch(() => 0);
      const inboundChanges = inboundOnlyChanges(changes);
      const messagesSaved = await saveInboundWhatsAppMessages(env, inboundChanges).catch(() => 0);
      const botTask = runBotForInboundMessages(env, inboundChanges).catch(() => null);
      const flushTask = flushQueuedStaffNotifications(env).catch(() => null);
      const takeoverTask = takeOverUnansweredHumanChats(env).catch(() => null);
      if (ctx?.waitUntil) { ctx.waitUntil(botTask); ctx.waitUntil(flushTask); ctx.waitUntil(takeoverTask); } else { await botTask; await flushTask; await takeoverTask; }
      return Response.json({ ok: true, received: statuses.length, messagesSaved, manualEchoesSaved });
    }

    if (url.pathname === "/api/whatsapp/inbox" && request.method === "GET") {
      const session = await readSession(request, env.OPERATIONS_ADMIN_SECRET);
      if (!session) return Response.json({ ok: false, error: "Sesion no autorizada." }, { status: 401 });
      await ensureWhatsAppInboxTable(env);
      await ensureWhatsAppBotTables(env);
      const rows = await env.DB.prepare(`SELECT message_id, phone, customer_name, direction, message_type,
        message_text, media_id, created_at FROM whatsapp_inbox_messages ORDER BY created_at DESC LIMIT 300`).all();
      const sessions = await env.DB.prepare(`SELECT phone, mode, escalation_reason, updated_by_user_id,
        updated_by_role, updated_at FROM whatsapp_bot_sessions ORDER BY updated_at DESC LIMIT 500`).all();
      return Response.json({ ok: true, messages: rows.results || [], sessions: sessions.results || [] });
    }

    if (url.pathname === "/api/whatsapp/media" && request.method === "GET") {
      const session = await readSession(request, env.OPERATIONS_ADMIN_SECRET);
      if (!session) return Response.json({ ok: false, error: "Sesion no autorizada." }, { status: 401 });
      const mediaId = String(url.searchParams.get("id") || "").trim();
      if (!/^\d+$/.test(mediaId)) return Response.json({ ok: false, error: "Comprobante inválido." }, { status: 400 });
      await ensureWhatsAppInboxTable(env);
      const storedMedia = await env.DB.prepare("SELECT media_id FROM whatsapp_inbox_messages WHERE media_id = ? LIMIT 1")
        .bind(mediaId).first();
      if (!storedMedia) return Response.json({ ok: false, error: "Comprobante no encontrado." }, { status: 404 });
      const credentials = await getWhatsAppCredentials(env);
      if (!credentials.accessToken) return Response.json({ ok: false, error: "WhatsApp todavía no está conectado." }, { status: 409 });
      const metadataResponse = await fetch(`https://graph.facebook.com/v25.0/${encodeURIComponent(mediaId)}`, {
        headers: { authorization: `Bearer ${credentials.accessToken}` },
      });
      const metadata = await metadataResponse.json().catch(() => ({}));
      if (!metadataResponse.ok || !metadata.url) {
        return Response.json({ ok: false, error: metadata.error?.message || "Meta no pudo abrir el comprobante." }, { status: 422 });
      }
      const mediaResponse = await fetch(metadata.url, {
        headers: { authorization: `Bearer ${credentials.accessToken}` },
      });
      if (!mediaResponse.ok || !mediaResponse.body) {
        return Response.json({ ok: false, error: "No se pudo descargar el comprobante desde Meta." }, { status: 422 });
      }
      return new Response(mediaResponse.body, {
        status: 200,
        headers: {
          "content-type": metadata.mime_type || mediaResponse.headers.get("content-type") || "application/octet-stream",
          "content-disposition": `inline; filename="comprobante-${mediaId}"`,
          "cache-control": "private, no-store, max-age=0",
          "x-content-type-options": "nosniff",
        },
      });
    }

    if (url.pathname === "/api/whatsapp/automation-cases" && request.method === "GET") {
      const session = await readSession(request, env.OPERATIONS_ADMIN_SECRET);
      if (!session) return Response.json({ ok: false, error: "Sesion no autorizada." }, { status: 401 });
      await ensureWhatsAppAutomationTable(env);
      const rows = await env.DB.prepare(`SELECT id, source_message_id, phone, customer_name, customer_id, reported_name,
        case_type, confidence, status, summary, service_month, amount, media_id, decision_note, created_at, updated_at
        FROM whatsapp_automation_cases ORDER BY created_at DESC LIMIT 200`).all();
      return Response.json({ ok: true, cases: rows.results || [] });
    }

    if (url.pathname === "/api/whatsapp/automation-cases" && request.method === "PATCH") {
      const session = await readSession(request, env.OPERATIONS_ADMIN_SECRET);
      if (!session) return Response.json({ ok: false, error: "Sesion no autorizada." }, { status: 401 });
      const body = await request.json().catch(() => ({}));
      const id = String(body.id || "").trim();
      const status = String(body.status || "").trim();
      const allowed = new Set(["suggested", "reviewing", "approved", "dismissed"]);
      if (!id || !allowed.has(status)) return Response.json({ ok: false, error: "Caso o estado inválido." }, { status: 400 });
      await ensureWhatsAppAutomationTable(env);
      const result = await env.DB.prepare(`UPDATE whatsapp_automation_cases
        SET status = ?, decision_note = ?, updated_at = datetime('now') WHERE id = ?`)
        .bind(status, String(body.note || "").trim().slice(0, 1000) || null, id).run();
      if (!result.meta?.changes) return Response.json({ ok: false, error: "Caso no encontrado." }, { status: 404 });
      return Response.json({ ok: true, id, status });
    }

    if (url.pathname === "/api/whatsapp/reply" && request.method === "POST") {
      const session = await readSession(request, env.OPERATIONS_ADMIN_SECRET);
      if (!session) return Response.json({ ok: false, error: "Sesion no autorizada." }, { status: 401 });
      const body = await request.json().catch(() => ({}));
      const phone = normalizeWhatsAppPhone(body.phone);
      const messageText = String(body.text || "").trim().slice(0, 4000);
      if (!phone || !messageText) return Response.json({ ok: false, error: "Falta teléfono o mensaje." }, { status: 400 });
      const credentials = await getWhatsAppCredentials(env);
      if (!credentials.accessToken || !credentials.phoneNumberId) return Response.json({ ok: false, error: "WhatsApp todavía no está conectado." }, { status: 409 });
      // La conversación queda en atención humana ANTES de enviar. Así, si entra un mensaje del
      // cliente mientras Meta procesa la respuesta, el bot no compite con el operador.
      await setBotSessionMode(env, phone, "human", "manual_reply", session);
      const endpoint = `https://graph.facebook.com/v25.0/${encodeURIComponent(credentials.phoneNumberId)}/messages`;
      const metaResponse = await fetch(endpoint, {
        method: "POST",
        headers: { authorization: `Bearer ${credentials.accessToken}`, "content-type": "application/json" },
        body: JSON.stringify({ messaging_product: "whatsapp", recipient_type: "individual", to: phone, type: "text", text: { body: messageText } }),
      });
      const meta = await metaResponse.json().catch(() => ({}));
      if (!metaResponse.ok) return Response.json({ ok: false, error: meta.error?.message || "Meta rechazó la respuesta.", errorCode: meta.error?.code }, { status: 422 });
      const messageId = meta.messages?.[0]?.id;
      await ensureWhatsAppInboxTable(env);
      await env.DB.prepare(`INSERT OR IGNORE INTO whatsapp_inbox_messages
        (message_id, phone, direction, message_type, message_text, created_at, raw_json)
        VALUES (?, ?, 'outbound', 'text', ?, ?, ?)`)
        .bind(messageId, phone, messageText, new Date().toISOString(), JSON.stringify(meta)).run();
      return Response.json({ ok: true, messageId });
    }

    if (url.pathname === "/api/whatsapp/message-status" && request.method === "GET") {
      const messageId = String(url.searchParams.get("id") || "").trim();
      if (!messageId) return Response.json({ ok: false, error: "Falta el identificador del mensaje." }, { status: 400 });
      await ensureWhatsAppStatusTable(env);
      const row = await env.DB.prepare("SELECT message_id, recipient, status, error_json, created_at, updated_at FROM whatsapp_message_status WHERE message_id = ?")
        .bind(messageId).first();
      return Response.json({
        ok: true,
        message: row ? {
          messageId: row.message_id,
          recipient: row.recipient,
          status: row.status,
          error: row.error_json ? JSON.parse(row.error_json) : null,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
        } : null,
      });
    }

    if (url.pathname === "/api/billing/automation/run" && request.method === "POST") {
      const oidc = await verifyBillingAutomationOidc(request);
      if (!oidc) return Response.json({ ok: false, error: "Ejecución automática no autorizada." }, { status: 401 });
      const result = await runBillingAutomation(env);
      return Response.json(result, { status: result.ok || result.skipped || result.blocked ? 200 : 502 });
    }

    if (url.pathname === "/api/whatsapp/sales-leads/follow-up" && request.method === "POST") {
      const oidc = await verifySalesFollowUpOidc(request);
      if (!oidc) return Response.json({ ok: false, error: "Ejecución automática no autorizada." }, { status: 401 });
      const result = await followUpStaleSalesLeads(env).catch((error) => ({ ok: false, error: String(error?.message || error) }));
      // Misma corrida de 10 minutos: además retoma los chats en modo humano que nadie atendió (ver
      // takeOverUnansweredHumanChats). Un fallo aquí no debe tumbar el seguimiento de leads.
      const takeover = await takeOverUnansweredHumanChats(env).catch((error) => ({ ok: false, error: String(error?.message || error) }));
      const digest = await alertStaffUnansweredChats(env).catch((error) => ({ ok: false, error: String(error?.message || error) }));
      return Response.json({ ...result, takeover, digest }, { status: result.ok ? 200 : 502 });
    }

    if (url.pathname === "/api/billing/automation" && request.method === "GET") {
      const session = await readSession(request, env.OPERATIONS_ADMIN_SECRET);
      if (!session) return Response.json({ ok: false, error: "Sesion no autorizada." }, { status: 401 });
      return Response.json(await billingAutomationDashboard(env));
    }

    if (url.pathname === "/api/billing/automation/templates" && request.method === "POST") {
      const session = await readSession(request, env.OPERATIONS_ADMIN_SECRET);
      if (!session || session.role !== "super_admin") return Response.json({ ok: false, error: "Solo un superadministrador puede crear plantillas." }, { status: 403 });
      const result = await syncBillingAutomationTemplates(env, true);
      return Response.json(result, { status: result.ok ? 200 : 502 });
    }

    if (url.pathname === "/api/billing/automation/test" && request.method === "POST") {
      const session = await readSession(request, env.OPERATIONS_ADMIN_SECRET);
      if (!session || session.role !== "super_admin") return Response.json({ ok: false, error: "Solo un superadministrador puede ejecutar pruebas." }, { status: 403 });
      const body = await request.json().catch(() => ({}));
      const stage = String(body.stage || "");
      const phone = normalizeWhatsAppPhone(body.phone);
      if (!BILLING_AUTOMATION_TEMPLATES[stage] || !/^56\d{9}$/.test(phone)) return Response.json({ ok: false, error: "Etapa o teléfono de prueba inválido." }, { status: 400 });
      const templates = await syncBillingAutomationTemplates(env, false);
      const template = templates.templates?.find((item) => item.stage === stage);
      if (template?.status !== "APPROVED") return Response.json({ ok: false, error: `Plantilla ${template?.status || "NOT_FOUND"}; no se envió.` }, { status: 409 });
      const result = await sendBillingAutomationTemplate(env, stage, phone);
      await ensureBillingAutomationTables(env);
      await env.DB.prepare(`INSERT INTO billing_automation_sends
        (billing_month,stage,phone,template_name,status,message_id,error_code,error_message,is_test,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,1,datetime('now'),datetime('now'))`)
        .bind(billingMonthKey(), stage, phone, template.name, result.ok ? "accepted" : "failed", result.messageId,
          result.errorCode ? String(result.errorCode) : null, result.error).run();
      return Response.json({ ok: result.ok, test: true, stage, phone, messageId: result.messageId, error: result.error }, { status: result.ok ? 200 : 422 });
    }

    if (url.pathname === "/api/billing/automation/queue" && request.method === "PATCH") {
      const session = await readSession(request, env.OPERATIONS_ADMIN_SECRET);
      if (!session) return Response.json({ ok: false, error: "Sesion no autorizada." }, { status: 401 });
      const body = await request.json().catch(() => ({}));
      const id = Number(body.id);
      const status = String(body.status || "");
      if (!Number.isInteger(id) || !["pending", "suspended", "paid", "dismissed"].includes(status)) return Response.json({ ok: false, error: "Registro o estado inválido." }, { status: 400 });
      await ensureBillingAutomationTables(env);
      const result = await env.DB.prepare("UPDATE billing_suspension_queue SET status=?,updated_at=datetime('now') WHERE id=?").bind(status, id).run();
      if (!result.meta?.changes) return Response.json({ ok: false, error: "Registro no encontrado." }, { status: 404 });
      return Response.json({ ok: true, id, status });
    }

    if (url.pathname === "/api/whatsapp/send-billing" && request.method === "POST") {
      const session = await readSession(request, env.OPERATIONS_ADMIN_SECRET);
      if (!session) return Response.json({ ok: false, error: "Sesion no autorizada." }, { status: 401 });
      return sendBillingMessages(request, env);
    }

    if (url.pathname === "/api/whatsapp/onboarding" && request.method === "GET") {
      const session = await readSession(request, env.OPERATIONS_ADMIN_SECRET);
      if (!session || session.role !== "super_admin") return Response.json({ ok: false, error: "Solo un superadministrador puede configurar Meta." }, { status: 403 });
      const credentials = await getWhatsAppCredentials(env);
      const appId = String(env.META_APP_ID || "").trim();
      const configId = String(env.META_EMBEDDED_SIGNUP_CONFIG_ID || "").trim();
      const featureType = String(env.META_EMBEDDED_SIGNUP_FEATURE || "").trim();
      const metaPhone = await getMetaPhoneConnection(credentials);
      const hasEmbeddedCredentials = Boolean(credentials.accessToken && credentials.phoneNumberId && credentials.wabaId && credentials.source === "embedded-signup");
      return Response.json({
        ok: true,
        readyToStart: Boolean(appId && configId && featureType && env.META_APP_SECRET),
        connected: hasEmbeddedCredentials && metaPhone.connected,
        needsCompletion: hasEmbeddedCredentials && !metaPhone.connected,
        metaPhoneStatus: metaPhone.status,
        appId,
        configId,
        featureType,
        businessId: String(env.META_BUSINESS_ID || ""),
        redirectUri: `${url.origin}/`,
        phoneNumberId: credentials.phoneNumberId ? `…${credentials.phoneNumberId.slice(-6)}` : "",
        wabaId: credentials.wabaId ? `…${credentials.wabaId.slice(-6)}` : "",
        connectedAt: credentials.connectedAt,
        businessVerified: true,
        checks: [
          { key: "META_BUSINESS_VERIFIED", label: "Negocio BPGO verificado por Meta", configured: true },
          { key: "META_APP_ID", label: "App BPGO COBRANZA", configured: Boolean(appId) },
          { key: "META_APP_SECRET", label: "Clave secreta protegida", configured: Boolean(String(env.META_APP_SECRET || "").trim()) },
          { key: "META_EMBEDDED_SIGNUP_CONFIG_ID", label: "Configuración de registro integrado", configured: Boolean(configId) },
          { key: "META_EMBEDDED_SIGNUP_FEATURE", label: "Modo de coexistencia", configured: Boolean(featureType) },
          { key: "OPERATIONS_ADMIN_SECRET", label: "Cifrado de credenciales", configured: Boolean(String(env.OPERATIONS_ADMIN_SECRET || "").trim()) },
        ],
      });
    }

    if (url.pathname === "/api/whatsapp/onboarding" && request.method === "POST") {
      const session = await readSession(request, env.OPERATIONS_ADMIN_SECRET);
      if (!session || session.role !== "super_admin") return Response.json({ ok: false, error: "Solo un superadministrador puede conectar Meta." }, { status: 403 });
      const body = await request.json().catch(() => ({}));
      const code = String(body.code || "").trim();
      const dialogRedirectUri = String(body.redirectUri || "").trim();
      let wabaId = String(body.wabaId || "").trim();
      let phoneNumberId = String(body.phoneNumberId || "").trim();
      const appId = String(env.META_APP_ID || "").trim();
      const appSecret = String(env.META_APP_SECRET || "").trim();
      if (!code) return Response.json({ ok: false, error: "Meta no entregó el código de autorización." }, { status: 400 });
      if ((wabaId && !/^\d+$/.test(wabaId)) || (phoneNumberId && !/^\d+$/.test(phoneNumberId))) {
        return Response.json({ ok: false, error: "Meta entregó identificadores inválidos." }, { status: 400 });
      }
      if (!appId || !appSecret || !env.OPERATIONS_ADMIN_SECRET) return Response.json({ ok: false, error: "Faltan secretos de Meta en Cloudflare." }, { status: 409 });

      const tokenUrl = new URL("https://graph.facebook.com/v25.0/oauth/access_token");
      tokenUrl.searchParams.set("client_id", appId);
      tokenUrl.searchParams.set("client_secret", appSecret);
      tokenUrl.searchParams.set("code", code);
      if (dialogRedirectUri) tokenUrl.searchParams.set("redirect_uri", dialogRedirectUri);
      const tokenResponse = await fetch(tokenUrl, { headers: { accept: "application/json" } });
      const tokenPayload = await tokenResponse.json().catch(() => ({}));
      const accessToken = String(tokenPayload.access_token || "").trim();
      if (!tokenResponse.ok || !accessToken) return Response.json({ ok: false, error: tokenPayload.error?.message || "Meta no pudo intercambiar el código de autorización." }, { status: 422 });

      // Embedded Signup puede autorizar correctamente y omitir el evento de
      // selección en el navegador. Resolvemos el número autorizado mediante
      // Graph para evitar que el usuario repita indefinidamente la ventana.
      if (!wabaId || !phoneNumberId) {
        const businessId = String(env.META_BUSINESS_ID || "").trim();
        if (!/^\d+$/.test(businessId)) {
          return Response.json({ ok: false, error: "Falta META_BUSINESS_ID para identificar automáticamente el número autorizado." }, { status: 409 });
        }
        const candidates = [];
        const seenWabas = new Set();
        for (const edge of ["owned_whatsapp_business_accounts", "client_whatsapp_business_accounts"]) {
          const accountsResponse = await fetch(`https://graph.facebook.com/v25.0/${encodeURIComponent(businessId)}/${edge}?fields=id,name&limit=100`, {
            headers: { authorization: `Bearer ${accessToken}` },
          });
          const accountsPayload = await accountsResponse.json().catch(() => ({}));
          if (!accountsResponse.ok) continue;
          for (const account of Array.isArray(accountsPayload.data) ? accountsPayload.data : []) {
            const accountId = String(account.id || "");
            if (!/^\d+$/.test(accountId) || seenWabas.has(accountId)) continue;
            seenWabas.add(accountId);
            const accountNumbersResponse = await fetch(`https://graph.facebook.com/v25.0/${encodeURIComponent(accountId)}/phone_numbers?fields=id,display_phone_number,verified_name,status&limit=100`, {
              headers: { authorization: `Bearer ${accessToken}` },
            });
            const accountNumbersPayload = await accountNumbersResponse.json().catch(() => ({}));
            if (!accountNumbersResponse.ok) continue;
            for (const number of Array.isArray(accountNumbersPayload.data) ? accountNumbersPayload.data : []) {
              if (!/^\d+$/.test(String(number.id || ""))) continue;
              candidates.push({
                wabaId: accountId,
                phoneNumberId: String(number.id),
                displayPhoneNumber: String(number.display_phone_number || ""),
              });
            }
          }
        }
        const uniqueCandidates = candidates.filter((candidate, index, list) =>
          list.findIndex((item) => item.phoneNumberId === candidate.phoneNumberId) === index
        );
        const expected = uniqueCandidates.find((candidate) => candidate.displayPhoneNumber.replace(/\D/g, "") === "56941985967");
        const selected = expected || (uniqueCandidates.length === 1 ? uniqueCandidates[0] : null);
        if (!selected) {
          return Response.json({
            ok: false,
            error: uniqueCandidates.length
              ? `Meta autorizó ${uniqueCandidates.length} números y no identificó automáticamente el +56 9 4198 5967.`
              : "Meta autorizó la cuenta, pero todavía no incorporó el número de WhatsApp Business a esta configuración.",
          }, { status: 422 });
        }
        wabaId = selected.wabaId;
        phoneNumberId = selected.phoneNumberId;
      }

      const numbersResponse = await fetch(`https://graph.facebook.com/v25.0/${encodeURIComponent(wabaId)}/phone_numbers?fields=id,display_phone_number,verified_name`, {
        headers: { authorization: `Bearer ${accessToken}` },
      });
      const numbersPayload = await numbersResponse.json().catch(() => ({}));
      const selectedNumber = Array.isArray(numbersPayload.data) ? numbersPayload.data.find((item) => String(item.id) === phoneNumberId) : null;
      if (!numbersResponse.ok || !selectedNumber) return Response.json({ ok: false, error: numbersPayload.error?.message || "El número no pertenece a la cuenta de WhatsApp autorizada." }, { status: 422 });

      const subscriptionResponse = await fetch(`https://graph.facebook.com/v25.0/${encodeURIComponent(wabaId)}/subscribed_apps`, {
        method: "POST",
        headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
        body: JSON.stringify({ subscribed_fields: ["messages"] }),
      });
      const subscriptionPayload = await subscriptionResponse.json().catch(() => ({}));
      if (!subscriptionResponse.ok || subscriptionPayload.success !== true) {
        return Response.json({ ok: false, error: subscriptionPayload.error?.message || "Meta no pudo suscribir el número al webhook de mensajes." }, { status: 422 });
      }

      await ensureWhatsAppOnboardingTable(env);
      const encryptedToken = await encryptCredential(accessToken, env.OPERATIONS_ADMIN_SECRET);
      await env.DB.prepare(`INSERT INTO whatsapp_onboarding_config
        (id, waba_id, phone_number_id, access_token_encrypted, connected_at, updated_at)
        VALUES ('primary', ?, ?, ?, datetime('now'), datetime('now'))
        ON CONFLICT(id) DO UPDATE SET waba_id = excluded.waba_id, phone_number_id = excluded.phone_number_id,
          access_token_encrypted = excluded.access_token_encrypted, connected_at = excluded.connected_at, updated_at = datetime('now')`)
        .bind(wabaId, phoneNumberId, encryptedToken).run();
      const connection = await getMetaPhoneConnection({ accessToken, phoneNumberId, wabaId });
      return Response.json({ ok: true, connected: connection.connected, status: connection.status, displayPhoneNumber: selectedNumber.display_phone_number, verifiedName: selectedNumber.verified_name });
    }

    if (url.pathname === "/api/whatsapp/register" && request.method === "POST") {
      return Response.json({ ok: false, error: "Los números con WhatsApp Business deben completar el registro dentro del flujo oficial de Meta." }, { status: 409 });
    }

    if (url.pathname === "/api/whatsapp/staff-notifications/diagnostic" && request.method === "GET") {
      const session = await readSession(request, env.OPERATIONS_ADMIN_SECRET);
      if (!session) return Response.json({ ok: false, error: "Sesion no autorizada." }, { status: 401 });
      await ensureStaffNotificationsLogTable(env);
      const row = await env.DB.prepare("SELECT * FROM staff_notifications_log WHERE status='failed' ORDER BY COALESCE(updated_at,created_at) DESC LIMIT 1").first();
      const stored = parseStoredJson(row?.response_json) || {};
      const primaryBody = parseStoredJson(row?.primary_response_json) || stored.primary || null;
      const fallbackBody = parseStoredJson(row?.fallback_response_json) || stored.fallback || null;
      const credentials = await getWhatsAppCredentials(env);
      const phonePath = credentials.phoneNumberId
        ? `${encodeURIComponent(credentials.phoneNumberId)}?fields=id,verified_name,display_phone_number,quality_rating,status`
        : "";
      const wabaPath = credentials.wabaId
        ? `${encodeURIComponent(credentials.wabaId)}?fields=id,name,currency,timezone_id,message_template_namespace`
        : "";
      const reviewPath = credentials.wabaId
        ? `${encodeURIComponent(credentials.wabaId)}?fields=account_review_status,business_verification_status`
        : "";
      const paymentPath = credentials.wabaId
        ? `${encodeURIComponent(credentials.wabaId)}?fields=primary_funding_id,purchase_order_number`
        : "";
      const [phone, waba, review, payment] = await Promise.all([
        phonePath ? metaDiagnosticRequest(credentials, phonePath) : Promise.resolve(null),
        wabaPath ? metaDiagnosticRequest(credentials, wabaPath) : Promise.resolve(null),
        reviewPath ? metaDiagnosticRequest(credentials, reviewPath) : Promise.resolve(null),
        paymentPath ? metaDiagnosticRequest(credentials, paymentPath) : Promise.resolve(null),
      ]);
      return Response.json({
        ok: true,
        classification: classifyStaffMetaFailure(primaryBody, fallbackBody),
        lastFailure: row ? {
          id: row.id, role: row.role, caseType: row.case_type, entityId: row.entity_id,
          createdAt: row.created_at, updatedAt: row.updated_at,
          httpStatus: row.http_status, errorCode: row.error_code || staffMetaError(fallbackBody || primaryBody).code,
          errorSubcode: row.error_subcode || staffMetaError(fallbackBody || primaryBody).subcode,
          errorMessage: row.error_message || staffMetaError(fallbackBody || primaryBody).message,
          errorDetails: row.error_details || staffMetaError(fallbackBody || primaryBody).details,
          fbtraceId: row.fbtrace_id || staffMetaError(fallbackBody || primaryBody).fbtraceId,
          attemptedTemplate: row.attempted_template || row.template_name,
          finalTemplate: row.final_template || row.template_name,
          fallbackUsed: Boolean(row.fallback_used),
          primary: { httpStatus: row.primary_http_status, response: sanitizeMetaDiagnostic(primaryBody) },
          fallback: { httpStatus: row.fallback_http_status, response: sanitizeMetaDiagnostic(fallbackBody) },
        } : null,
        configuration: {
          credentialSource: credentials.source,
          phoneNumberId: credentials.phoneNumberId ? `…${credentials.phoneNumberId.slice(-6)}` : "",
          wabaId: credentials.wabaId ? `…${credentials.wabaId.slice(-6)}` : "",
          phone, waba, review, payment,
        },
      });
    }

    if (url.pathname === "/api/whatsapp/staff-notifications/test" && request.method === "POST") {
      const session = await readSession(request, env.OPERATIONS_ADMIN_SECRET);
      if (!session) return Response.json({ ok: false, error: "Sesion no autorizada." }, { status: 401 });
      const credentials = await getWhatsAppCredentials(env);
      const to = normalizeWhatsAppPhone(env.STAFF_PHONE_CARLOS);
      if (!credentials.accessToken || !credentials.phoneNumberId || !/^\d{8,15}$/.test(String(to || ""))) {
        return Response.json({ ok: false, error: "Configuración de Meta o Carlos incompleta." }, { status: 409 });
      }
      const metaResponse = await fetch(`https://graph.facebook.com/v25.0/${encodeURIComponent(credentials.phoneNumberId)}/messages`, {
        method: "POST",
        headers: { authorization: `Bearer ${credentials.accessToken}`, "content-type": "application/json" },
        body: JSON.stringify({
          messaging_product: "whatsapp", recipient_type: "individual", to, type: "template",
          template: { name: "aviso_nuevo_caso", language: { code: "es_CL" }, components: [{ type: "body", parameters: [
            { type: "text", text: "Prueba diagnóstica" }, { type: "text", text: "Cliente de prueba" },
            { type: "text", text: "56900000000" }, { type: "text", text: "Prueba controlada del panel; no corresponde a un caso real." },
          ] }] },
        }),
      }).catch((error) => ({ ok: false, status: 0, json: async () => ({ error: { message: String(error?.message || error) } }) }));
      const responseBody = sanitizeMetaDiagnostic(await metaResponse.json().catch(() => ({})));
      return Response.json({ ok: Boolean(metaResponse.ok), httpStatus: Number(metaResponse.status || 0), template: "aviso_nuevo_caso", response: responseBody }, { status: metaResponse.ok ? 200 : 422 });
    }

    if (url.pathname === "/api/whatsapp/staff-notifications" && request.method === "GET") {
      const session = await readSession(request, env.OPERATIONS_ADMIN_SECRET);
      if (!session) return Response.json({ ok: false, error: "Sesion no autorizada." }, { status: 401 });
      await ensureStaffNotificationsLogTable(env);
      const rows = await env.DB.prepare(`SELECT id,role,case_type,customer_name,entity_type,entity_id,template_name,status,
        http_status,error_code,error_subcode,error_message,error_details,fbtrace_id,attempt_count,created_at,updated_at,
        attempted_template,final_template,fallback_used,primary_http_status,fallback_http_status,primary_response_json,fallback_response_json,response_json
        FROM staff_notifications_log ORDER BY created_at DESC LIMIT 300`).all();
      const items = rows.results || [];
      const stats = { carlos: { sent: 0, delivered: 0, failed: 0 }, eduardo: { sent: 0, delivered: 0, failed: 0 } };
      for (const item of items) {
        if (!stats[item.role]) continue;
        if (item.status === "failed") stats[item.role].failed += 1;
        else if (["delivered", "read"].includes(item.status)) stats[item.role].delivered += 1;
        else if (["accepted", "sent"].includes(item.status)) stats[item.role].sent += 1;
      }
      return Response.json({ ok: true, stats, failed: items.filter((item) => item.status === "failed"), configured: {
        carlos: /^\d{8,15}$/.test(String(normalizeWhatsAppPhone(env.STAFF_PHONE_CARLOS) || "")),
        eduardo: /^\d{8,15}$/.test(String(normalizeWhatsAppPhone(env.STAFF_PHONE_EDUARDO) || "")),
      } });
    }

    if (url.pathname === "/api/whatsapp/staff-notifications/retry" && request.method === "POST") {
      const session = await readSession(request, env.OPERATIONS_ADMIN_SECRET);
      if (!session) return Response.json({ ok: false, error: "Sesion no autorizada." }, { status: 401 });
      const body = await request.json().catch(() => ({}));
      const id = Number(body.id);
      if (!Number.isInteger(id) || id < 1) return Response.json({ ok: false, error: "Notificación inválida." }, { status: 400 });
      await ensureStaffNotificationsLogTable(env);
      const row = await env.DB.prepare("SELECT * FROM staff_notifications_log WHERE id=?").bind(id).first();
      if (!row) return Response.json({ ok: false, error: "Notificación no encontrada." }, { status: 404 });
      if (row.status !== "failed") return Response.json({ ok: false, error: "Solo se pueden reintentar notificaciones fallidas." }, { status: 409 });
      const lock = await env.DB.prepare("UPDATE staff_notifications_log SET status='pending',updated_at=datetime('now') WHERE id=? AND status='failed'").bind(id).run();
      if (!lock.meta?.changes) return Response.json({ ok: false, error: "La notificación ya está siendo procesada." }, { status: 409 });
      const credentials = await getWhatsAppCredentials(env);
      const result = await deliverStaffNotification(env, credentials, row).catch(async (error) => {
        await env.DB.prepare("UPDATE staff_notifications_log SET status='failed',error_message=?,updated_at=datetime('now') WHERE id=?")
          .bind(String(error?.message || error), id).run().catch(() => null);
        return { ok: false, status: "failed", error: String(error?.message || error) };
      });
      return Response.json(result, { status: result.ok ? 200 : 422 });
    }

    if (url.pathname === "/api/whatsapp/bot-sessions" && request.method === "GET") {
      const session = await readSession(request, env.OPERATIONS_ADMIN_SECRET);
      if (!session) return Response.json({ ok: false, error: "Sesion no autorizada." }, { status: 401 });
      await ensureWhatsAppBotTables(env);
      const rows = await env.DB.prepare(`SELECT phone, mode, escalation_reason, updated_by_user_id, updated_by_role, updated_at FROM whatsapp_bot_sessions
        WHERE mode = 'human' ORDER BY updated_at DESC LIMIT 200`).all();
      return Response.json({ ok: true, sessions: rows.results || [] });
    }

    if (url.pathname === "/api/whatsapp/bot-sessions" && request.method === "PATCH") {
      const session = await readSession(request, env.OPERATIONS_ADMIN_SECRET);
      if (!session) return Response.json({ ok: false, error: "Sesion no autorizada." }, { status: 401 });
      const body = await request.json().catch(() => ({}));
      const phone = normalizeWhatsAppPhone(body.phone);
      const mode = String(body.mode || "").trim();
      if (!phone || !["bot", "human"].includes(mode)) return Response.json({ ok: false, error: "Teléfono o modo inválido." }, { status: 400 });
      await setBotSessionMode(env, phone, mode, mode === "human" ? "manual_takeover" : "manual_reactivated", session);
      const current = await getBotSessionRow(env, phone);
      return Response.json({ ok: true, phone, mode, session: current });
    }

    if (url.pathname === "/api/whatsapp/visit-requests" && request.method === "GET") {
      const session = await readSession(request, env.OPERATIONS_ADMIN_SECRET);
      if (!session) return Response.json({ ok: false, error: "Sesion no autorizada." }, { status: 401 });
      await ensureWhatsAppBotTables(env);
      const rows = await env.DB.prepare(`SELECT id, phone, customer_id, customer_name, reported_name, preferred_date, reason, status, created_at, transcript
        FROM whatsapp_visit_requests ORDER BY created_at DESC LIMIT 200`).all();
      return Response.json({ ok: true, requests: rows.results || [] });
    }

    if (url.pathname === "/api/whatsapp/visit-requests" && request.method === "PATCH") {
      const session = await readSession(request, env.OPERATIONS_ADMIN_SECRET);
      if (!session) return Response.json({ ok: false, error: "Sesion no autorizada." }, { status: 401 });
      const body = await request.json().catch(() => ({}));
      const id = Number(body.id);
      const status = String(body.status || "").trim();
      if (!id || !["pending", "scheduled", "dismissed"].includes(status)) return Response.json({ ok: false, error: "Solicitud o estado inválido." }, { status: 400 });
      await ensureWhatsAppBotTables(env);
      const result = await env.DB.prepare("UPDATE whatsapp_visit_requests SET status = ? WHERE id = ?").bind(status, id).run();
      if (!result.meta?.changes) return Response.json({ ok: false, error: "Solicitud no encontrada." }, { status: 404 });
      return Response.json({ ok: true, id, status });
    }

    if (url.pathname === "/api/whatsapp/billing-requests" && request.method === "GET") {
      const session = await readSession(request, env.OPERATIONS_ADMIN_SECRET);
      if (!session) return Response.json({ ok: false, error: "Sesion no autorizada." }, { status: 401 });
      await ensureWhatsAppBotTables(env);
      const rows = await env.DB.prepare(`SELECT id, phone, customer_id, customer_name, reported_name, days_without_service, reason, status, created_at, transcript
        FROM whatsapp_billing_requests ORDER BY created_at DESC LIMIT 200`).all();
      return Response.json({ ok: true, requests: rows.results || [] });
    }

    if (url.pathname === "/api/whatsapp/billing-requests" && request.method === "PATCH") {
      const session = await readSession(request, env.OPERATIONS_ADMIN_SECRET);
      if (!session) return Response.json({ ok: false, error: "Sesion no autorizada." }, { status: 401 });
      const body = await request.json().catch(() => ({}));
      const id = Number(body.id);
      const status = String(body.status || "").trim();
      if (!id || !["pending", "resolved", "dismissed"].includes(status)) return Response.json({ ok: false, error: "Solicitud o estado inválido." }, { status: 400 });
      await ensureWhatsAppBotTables(env);
      const result = await env.DB.prepare("UPDATE whatsapp_billing_requests SET status = ? WHERE id = ?").bind(status, id).run();
      if (!result.meta?.changes) return Response.json({ ok: false, error: "Solicitud no encontrada." }, { status: 404 });
      return Response.json({ ok: true, id, status });
    }

    if (url.pathname === "/api/whatsapp/sales-leads" && request.method === "GET") {
      const session = await readSession(request, env.OPERATIONS_ADMIN_SECRET);
      if (!session) return Response.json({ ok: false, error: "Sesion no autorizada." }, { status: 401 });
      await ensureWhatsAppBotTables(env);
      const rows = await env.DB.prepare(`SELECT id, phone, customer_name, sector, plan_group, chosen_plan, latitude, longitude, status,
        installation_name, installation_rut, installation_phone, installation_email, installation_address, created_at, updated_at
        FROM whatsapp_sales_leads ORDER BY created_at DESC LIMIT 200`).all();
      return Response.json({ ok: true, leads: rows.results || [] });
    }

    if (url.pathname === "/api/whatsapp/sales-leads" && request.method === "PATCH") {
      const session = await readSession(request, env.OPERATIONS_ADMIN_SECRET);
      if (!session) return Response.json({ ok: false, error: "Sesion no autorizada." }, { status: 401 });
      const body = await request.json().catch(() => ({}));
      const id = String(body.id || "").trim();
      const status = String(body.status || "").trim();
      const allowed = new Set(["awaiting_sector", "awaiting_location", "awaiting_factibilidad", "awaiting_group_clarification",
        "no_factibilidad", "awaiting_plan", "awaiting_installation_data", "completed", "cancelled"]);
      if (!id || !allowed.has(status)) return Response.json({ ok: false, error: "Solicitud o estado inválido." }, { status: 400 });
      await ensureWhatsAppBotTables(env);
      const result = await env.DB.prepare("UPDATE whatsapp_sales_leads SET status = ?, updated_at = datetime('now') WHERE id = ?").bind(status, id).run();
      if (!result.meta?.changes) return Response.json({ ok: false, error: "Solicitud no encontrada." }, { status: 404 });
      return Response.json({ ok: true, id, status });
    }

    if (url.pathname === "/api/whatsapp/bot-faq" && request.method === "GET") {
      const session = await readSession(request, env.OPERATIONS_ADMIN_SECRET);
      if (!session) return Response.json({ ok: false, error: "Sesion no autorizada." }, { status: 401 });
      await ensureWhatsAppBotTables(env);
      const rows = await env.DB.prepare("SELECT key, value, updated_at FROM bpgo_bot_faq ORDER BY key ASC").all();
      return Response.json({ ok: true, items: rows.results || [], defaultText: DEFAULT_BOT_FAQ });
    }

    if (url.pathname === "/api/whatsapp/bot-faq" && request.method === "PUT") {
      const session = await readSession(request, env.OPERATIONS_ADMIN_SECRET);
      if (!session) return Response.json({ ok: false, error: "Sesion no autorizada." }, { status: 401 });
      const body = await request.json().catch(() => ({}));
      const key = String(body.key || "").trim().slice(0, 100);
      const value = String(body.value || "").trim().slice(0, 4000);
      if (!key) return Response.json({ ok: false, error: "Falta la clave del FAQ." }, { status: 400 });
      await ensureWhatsAppBotTables(env);
      if (!value) {
        await env.DB.prepare("DELETE FROM bpgo_bot_faq WHERE key = ?").bind(key).run();
        return Response.json({ ok: true, deleted: true, key });
      }
      await env.DB.prepare(`INSERT INTO bpgo_bot_faq (key, value, updated_at) VALUES (?, ?, datetime('now'))
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`).bind(key, value).run();
      return Response.json({ ok: true, key, value });
    }

    if (url.pathname === "/api/whatsapp/status" && request.method === "GET") {
      const credentials = await getWhatsAppCredentials(env);
      const billingTemplateStatus = await syncBillingAutomationTemplates(env, false)
        .catch((error) => ({ ok: false, error: String(error?.message || error), templates: [] }));
      const checks = [
        { key: "WHATSAPP_ACCESS_TOKEN", configured: Boolean(credentials.accessToken) },
        { key: "WHATSAPP_PHONE_NUMBER_ID", configured: Boolean(credentials.phoneNumberId) },
        { key: "WHATSAPP_TEMPLATE_NAME", configured: Boolean(String(env.WHATSAPP_TEMPLATE_NAME || "").trim()) },
        { key: "WHATSAPP_TEMPLATE_LANGUAGE", configured: Boolean(String(env.WHATSAPP_TEMPLATE_LANGUAGE || "").trim()) },
        { key: "WHATSAPP_WEBHOOK_SECRET", configured: Boolean(String(env.WHATSAPP_WEBHOOK_SECRET || "").trim()) },
      ];
      let metaConnection = { ok: false, error: "Configuracion incompleta" };
      if (checks[0].configured && checks[1].configured) {
        metaConnection = await getMetaPhoneConnection(credentials);
        if (metaConnection.ok) {
          const templatesResponse = credentials.wabaId ? await fetch(`https://graph.facebook.com/v25.0/${encodeURIComponent(credentials.wabaId)}/message_templates?name=${encodeURIComponent(String(env.WHATSAPP_TEMPLATE_NAME || "").trim())}&fields=name,status,language,category`, {
            headers: { authorization: `Bearer ${credentials.accessToken}` },
          }) : null;
          const templates = templatesResponse ? await templatesResponse.json().catch(() => ({})) : {};
          metaConnection.template = templatesResponse?.ok
            ? (templates.data?.[0] || null)
            : { error: templatesResponse ? (templates.error?.message || "No se pudo consultar la plantilla") : "Falta WHATSAPP_WABA_ID", errorCode: templates.error?.code };
        }
      }
      return Response.json({
        ok: true,
        configured: checks.every((item) => item.configured),
        checks,
        metaConnection,
        webhookUrl: `${url.origin}/api/whatsapp/webhook`,
        templateName: String(env.WHATSAPP_TEMPLATE_NAME || ""),
        templateLanguage: String(env.WHATSAPP_TEMPLATE_LANGUAGE || ""),
        checkedAt: new Date().toISOString(),
        credentialSource: credentials.source,
        connectedAt: credentials.connectedAt,
        billingTemplates: billingTemplateStatus.templates || [],
        billingTemplatesError: billingTemplateStatus.ok ? null : billingTemplateStatus.error,
      });
    }

    if (url.pathname.startsWith("/api/")) {
      url.protocol = "https:";
      url.hostname = STABLE_BACKEND;
      url.port = "";
      return fetch(new Request(url, request));
    }

    const assetResponse = await env.ASSETS.fetch(request);
    if (url.pathname === "/" || url.pathname === "/index.html" || url.pathname === "/assets/index-bulk-v28.js" || url.pathname === "/assets/password-save-v6.js" || url.pathname === "/assets/sheets-resilience-v9.js" || url.pathname === "/assets/billing-automation-v1.js" || url.pathname === "/assets/billing-automation-v1.css" || url.pathname === "/assets/cyber-upgrade-v1.js" || url.pathname === "/assets/cyber-upgrade-v1.css" || url.pathname === "/assets/mobile-ux-v11.js" || url.pathname === "/assets/billing-mobile-search-v12.js" || url.pathname === "/assets/mobile-tables-v13.js" || url.pathname === "/assets/technician-shifts-v15.js" || url.pathname === "/assets/agenda-shift-guard-v24.js" || url.pathname === "/assets/enterprise-v22.js" || url.pathname === "/assets/planta-externa-entry.js" || url.pathname === "/assets/operations-points-v29.js" || url.pathname === "/assets/whatsapp-onboarding-v43.js" || url.pathname === "/assets/whatsapp-test-v41.js" || url.pathname === "/assets/mobile-v5.css" || url.pathname === "/assets/enterprise-v22.css" || url.pathname === "/assets/operations-points-v29.css" || url.pathname === "/assets/whatsapp-onboarding-v42.css") {
      const headers = new Headers(assetResponse.headers);
      headers.set("cache-control", "no-store, no-cache, must-revalidate, max-age=0");
      headers.set("pragma", "no-cache");
      headers.set("expires", "0");
      return new Response(assetResponse.body, {
        status: assetResponse.status,
        statusText: assetResponse.statusText,
        headers,
      });
    }
    return assetResponse;
  },
};

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
  const hasPaymentMedia = Boolean(message.mediaId) && ["image", "document"].includes(message.type);
  const hasReceipt = paymentWords && hasPaymentMedia;
  if (paymentWords) {
    return {
      type: "payment",
      confidence: hasReceipt ? 96 : 70,
      summary: hasReceipt ? "Cliente indica que adjuntó un comprobante para validación." : "Cliente informa un pago; falta revisar el comprobante.",
      serviceMonth: inferServiceMonth(text, message.createdAt),
      amount: inferAmount(text),
    };
  }
  if (faultWords) {
    return { type: "technical_fault", confidence: 90, summary: "Posible falla de servicio para crear como orden por planificar.", serviceMonth: null, amount: null };
  }
  return { type: "general", confidence: 35, summary: "Consulta general pendiente de atención.", serviceMonth: null, amount: null };
}

function normalizeComparablePhone(value) {
  const phone = normalizeWhatsAppPhone(value);
  return phone.length >= 8 ? phone.slice(-8) : phone;
}

async function findCustomerForWhatsApp(env, phone, fallbackName) {
  const row = await env.DB.prepare("SELECT data FROM app_state WHERE id = 'main'").first().catch(() => null);
  const state = row?.data ? JSON.parse(row.data) : null;
  const collections = [state?.billingCustomers, state?.customers].filter(Array.isArray);
  const wanted = normalizeComparablePhone(phone);
  for (const customer of collections.flat()) {
    const candidate = normalizeComparablePhone(customer.phone || customer.whatsapp || customer.telefono || "");
    if (wanted && candidate && wanted === candidate) {
      return {
        id: String(customer.id || customer.rut || customer.name || ""),
        name: customer.name || customer.client || fallbackName || null,
        address: customer.address || customer.direccion || null,
        balance: customer.amount ?? customer.saldo ?? customer.deuda ?? null,
        dueDate: customer.dueDate || customer.vencimiento || null,
        paymentStatus: customer.status || null,
      };
    }
  }
  return { id: null, name: fallbackName || null, address: null, balance: null, dueDate: null, paymentStatus: null };
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
  return { history, customer, faq };
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
    return await deliverStaffNotification(env, credentials, row);
  } catch (error) {
    console.error("staff_notification_failed", role, caseType, String(error?.message || error));
    return { ok: false, status: "failed", error: String(error?.message || error) };
  }
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

function matchPlanGroup(sectorText) {
  const norm = String(sectorText || "").toLowerCase();
  if (norm.includes("cayucupil")) return "cayucupil";
  if (["peleco", "lanalhue", "trangilboro", "llenquehue"].some((s) => norm.includes(s))) return "otros";
  return null;
}

function formatPlansMessage(groupKey) {
  const group = PLAN_GROUPS[groupKey];
  if (!group) return null;
  const lines = group.plans.map((p) => `• ${p.speed} — $${p.price.toLocaleString("es-CL")}/mes`).join("\n");
  return `¡Buenas noticias! Sí tenemos factibilidad en tu sector. 🎉\n\nEstos son los planes disponibles:\n${lines}\n\nCosto de instalación (pago único): $${INSTALLATION_COST.toLocaleString("es-CL")}\n\n¿Cuál plan te gustaría contratar?`;
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
  return group.plans.find((p) => parseInt(p.speed, 10) === Number(anyNumber[1])) || null;
}

function planConfirmationMessage(plan) {
  return `¡Excelente decisión! Con el plan ${plan.speed} ($${plan.price.toLocaleString("es-CL")}/mes) puedes realizar todo lo necesario para navegar. 🎉\n\n📌 Al momento de la instalación se debe pagar el costo de instalación 🔧 ($${INSTALLATION_COST.toLocaleString("es-CL")}), más el valor del servicio del mes por adelantado 📆, el cual se calcula de forma proporcional según los días que resten del mes ⏳.\n\nQuedamos atentos a cualquier consulta.\nBP GO 💻⚡`;
}

const NO_FACTIBILIDAD_MESSAGE = "Lamentablemente por el momento no contamos con factibilidad técnica en tu sector 😔. Dejamos registrada tu solicitud y, apenas ampliemos cobertura en tu zona, te avisaremos de inmediato. ¡Gracias por tu interés en BPGO! 💙";

const INSTALLATION_DATA_REQUEST_MESSAGE = "Necesito los siguientes datos para realizar la instalación:\n\nNombre del titular:\nRut:\nNúmero de teléfono:\nCorreo:\nDirección:\n\nMe los puedes enviar todos juntos o uno por uno, como te acomode. 🙌";

const INSTALLATION_FIELD_LABELS = { name: "nombre del titular", rut: "RUT", phone: "número de teléfono", email: "correo", address: "dirección" };

// Algunos clientes no mandan el formulario completo en un solo mensaje, van completando los datos
// de a poco -- este clasificador corre en CADA mensaje mientras falten datos y va llenando lo que
// falta, sin depender de que llegue todo junto ni en un orden fijo. RUT/correo/teléfono son
// fáciles de reconocer por formato; nombre y dirección (ambos texto libre) usan una heurística
// simple (dígitos o palabras típicas de dirección) y, si es ambigua, se completa primero el nombre.
function classifyInstallationFragment(text, current) {
  const raw = String(text || "").trim();
  if (!raw) return null;
  const rutMatch = raw.match(/\b\d{1,2}\.?\d{3}\.?\d{3}-[\dkK]\b/);
  if (rutMatch) return { field: "rut", value: rutMatch[0] };
  const emailMatch = raw.match(/[^\s@]+@[^\s@]+\.[^\s@]+/);
  if (emailMatch) return { field: "email", value: emailMatch[0].toLowerCase() };
  const digitsOnly = raw.replace(/\D/g, "");
  if (digitsOnly.length >= 8 && digitsOnly.length <= 12 && !/[a-zA-Z]/.test(raw)) return { field: "phone", value: raw };
  const looksLikeAddress = /\d/.test(raw) || /\b(calle|avenida|av\.?|pasaje|camino|sector|km|villa|poblaci[oó]n|parcela|block|depto|casa)\b/i.test(raw);
  if (looksLikeAddress) return { field: "address", value: current.address ? `${current.address} ${raw}`.trim() : raw };
  // Texto libre sin dígitos ni palabras de dirección: mientras no haya aparecido ninguna señal de
  // dirección todavía, se asume que sigue siendo parte del nombre (para no cortar nombres
  // compuestos que el cliente manda palabra por palabra); una vez que la dirección ya empezó, el
  // texto libre que sigue se suma ahí.
  if (!current.address) return { field: "name", value: current.name ? `${current.name} ${raw}`.trim() : raw };
  return { field: "address", value: `${current.address} ${raw}`.trim() };
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

const BOT_SYSTEM_PROMPT = `Eres el asistente de WhatsApp de BPGO, un proveedor de internet/TV cable en Chile. Respondes en español, tono cercano y breve (2-4 frases, sin inventar información que no tengas).

Reglas duras, nunca las rompas:
- NUNCA confirmes ni marques un pago como "recibido" o "verificado" en el sistema. Si el cliente dice que pagó o envía un comprobante (imagen o PDF, en cualquier formato de banco/app, no todos se ven iguales), solo agradece la recepción y explica que el equipo lo va a revisar (usa la acción "payment_ack"). Si en la imagen del comprobante puedes leer CLARAMENTE el monto pagado y la fecha del pago, ponlos en "extracted_amount" (solo el número, sin $ ni puntos) y "extracted_date" (como aparezca, ej. "15-09-2026"). Si no los ves con certeza, déjalos vacíos: nunca inventes un monto o fecha.
- Si el cliente pide el link/enlace para pagar, pregunta dónde pagar, cómo pagar online o quiere pagar su plan, responde directamente con el único portal oficial: https://bpgo.cl/pagar. No escales este caso ni inventes otro enlace.
- Si el cliente pregunta cuánto debe, cuándo vence su pago, o el estado de su cuenta: usa EXCLUSIVAMENTE el dato de "Cliente identificado" (saldo/vencimiento) que te doy abajo, con la acción "reply". Nunca inventes un monto o fecha. "Saldo no disponible para confirmar automáticamente" NUNCA significa $0 ni "no debes pagar". Si el saldo no está confirmado, usa "escalate" para revisión humana.
- Una imagen o documento por sí solo NUNCA es un comprobante. Usa "payment_ack" solo si el texto del cliente dice claramente que pagó/envía comprobante, o si la imagen muestra inequívocamente un comprobante bancario/transferencia con señales como monto, banco, fecha, destinatario o número de operación. Fotos genéricas, catálogos, routers u otras imágenes no son pagos.
- "billing_review_request" (Descuento por corte) es SOLO para cuando el cliente pide explícitamente el descuento/ajuste, o pregunta directamente cuánto le van a cobrar o descontar por los días sin servicio (ej. "me van a descontar esos días?", "cuánto tengo que pagar si estuve sin internet", "quiero que me hagan un descuento"). Si el cliente SOLO está reportando la falla y respondiendo tu diagnóstico técnico (aunque mencione hace cuántos días o desde qué hora no tiene servicio), eso NO es un pedido de descuento -- sigue el flujo de diagnóstico técnico normal de más abajo, NO uses "billing_review_request" solo porque haya un número de días de por medio. Cuando sí corresponda billing_review_request: NUNCA calcules ni menciones ningún monto, descuento o total ajustado, bajo ninguna circunstancia. Eso solo lo decide un humano. Usa "reply" para preguntar cuántos días exactos estuvo sin servicio si no te lo ha dicho, y cuando lo tengas usa la acción "billing_review_request" con "days_without_service" (número) y un resumen en "reason" — nunca en "text" va un monto.
- Si el cliente reporta una falla técnica (sin internet, lento, intermitente, etc.) y NO pidió una visita ni un descuento todavía, NO uses "visit_request" de inmediato. Primero hace diagnóstico progresivo con la acción "reply", preguntando UNA cosa a la vez (color/estado de la luz del router, si ya reinició el equipo, si afecta a todos los dispositivos o solo uno, hace cuánto/desde cuándo empezó). Sigue así hasta que el cliente confirme que afecta a todos los dispositivos, ya respondió 2-3 preguntas y el problema sigue, o pida explícitamente una visita/técnico. En ese momento usa "visit_request" con un resumen COMPLETO en "reason" -- no una frase corta: incluye todo lo que el cliente contó (color/estado de la luz, si reinició el router y qué pasó, si afecta a todos los dispositivos o solo uno, hace cuánto/desde cuándo, y cualquier otro detalle que haya dado) para que el técnico que llegue a terreno ya sepa qué está pasando sin tener que volver a preguntar (el sistema se encarga por su cuenta de pedir el nombre del titular si hace falta, no necesitas preguntarlo tú). Nunca confirmes un horario exacto, solo di que quedó registrada la solicitud. Este es el flujo normal para "estoy sin internet" -- billing_review_request NUNCA reemplaza este flujo, son cosas distintas (una es mandar un técnico, la otra es un descuento que el cliente pidió aparte).
- Reserva la acción "escalate" solo para: el cliente pide explícitamente hablar con una persona, insulta, hace un reclamo grave, o pregunta algo puntual que no sabes con certeza (fuera de las FAQs y de los datos de cliente dados). Si el mensaje es corto, ambiguo, tiene errores de tipeo, o simplemente no lo entiendes (ej. "hol", una palabra suelta, algo cortado), NUNCA escales por eso solo: usa "reply" y pide amablemente que repita o aclare qué necesita. Escala únicamente si ya pediste aclaración y el cliente sigue sin poder comunicar lo que necesita.
- Si el cliente escribe porque quiere CONTRATAR internet por primera vez (no es cliente ya identificado, o pide un nuevo punto/dirección), usa la acción "new_customer_request" y no digas nada más tú: el sistema se encarga de preguntar el sector, pedir la ubicación, revisar factibilidad con el equipo y mostrar los planes, todo por su cuenta.
- Para todo lo demás (preguntas frecuentes, saludos, consultas generales que sí puedes responder con las FAQs dadas), usa la acción "reply".

Debes responder SIEMPRE llamando a la herramienta bpgo_bot_action con una única acción.`;

function formatCurrency(value) {
  if (value === null || value === undefined || String(value).trim() === "") return null;
  const amount = Number(value);
  return Number.isFinite(amount) ? `${amount.toLocaleString("es-CL")}` : null;
}

function confirmedBalanceText(customer) {
  if (!customer) return null;
  if (customer.balance === null || customer.balance === undefined || String(customer.balance).trim() === "") return null;
  const amount = Number(customer.balance);
  if (!Number.isFinite(amount)) return null;
  if (amount > 0) return `saldo pendiente ${amount.toLocaleString("es-CL")}`;
  const status = String(customer.paymentStatus || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  if (amount === 0 && /pagad|al dia|sin deuda/.test(status)) return "sin deuda pendiente confirmada";
  return null;
}

const PAYMENT_PORTAL_REPLY = "Puedes pagar tu mensualidad en el portal oficial de BP GO:\nhttps://bpgo.cl/pagar";

function isPaymentLinkRequest(value) {
  const text = String(value || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/\s+/g, " ").trim();
  return /\b(link|enlace)\b.{0,40}\b(pago|pagar)\b/.test(text)
    || /\b(donde|como)\s+(?:puedo\s+)?(?:pago|pagar)\b/.test(text)
    || /\bpagar\s+(?:el|mi|la)?\s*(?:plan|mensualidad)\b/.test(text);
}

async function callBotResponder(env, context, inboundMessage, media) {
  if (isPaymentLinkRequest(inboundMessage?.text)) return { action: "reply", text: PAYMENT_PORTAL_REPLY };
  if (!env.OPENAI_API_KEY) return { action: "escalate", reason: "bot_not_configured" };
  let customerLine = "No se pudo identificar al cliente en el sistema por su número.";
  if (context.customer?.name) {
    const balanceText = confirmedBalanceText(context.customer);
    const details = [
      context.customer.address ? `dirección ${context.customer.address}` : null,
      balanceText || "saldo no disponible para confirmar automáticamente",
      context.customer.dueDate ? `vencimiento ${context.customer.dueDate}` : null,
    ].filter(Boolean).join(", ");
    customerLine = `Cliente identificado: ${context.customer.name} (${details}).`;
  }
  const historyLines = context.history
    .map((item) => `${item.direction === "inbound" ? "Cliente" : "BPGO"}: ${item.message_text || `[${item.message_type}]`}`)
    .join("\n");
  const userContent = [];
  let mediaNote = "";
  if (media && media.mimeType.startsWith("image/")) {
    userContent.push({ type: "image_url", image_url: { url: `data:${media.mimeType};base64,${media.base64}` } });
  } else if (media) {
    mediaNote = "\n\n(El cliente adjuntó un documento, probablemente un comprobante en PDF, que no se puede visualizar aquí.)";
  }
  userContent.push({
    type: "text",
    text: `FAQs de BPGO:\n${context.faq}\n\n${customerLine}\n\nÚltimos mensajes de la conversación:\n${historyLines || "(sin historial previo)"}\n\nNuevo mensaje del cliente (${inboundMessage.type}): ${inboundMessage.text || "(sin texto, ver adjunto)"}${mediaNote}`,
  });

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: String(env.OPENAI_MODEL || "gpt-4o-mini"),
      max_tokens: 600,
      messages: [
        { role: "system", content: BOT_SYSTEM_PROMPT },
        { role: "user", content: userContent },
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
              days_without_service: { type: "number", description: "Cantidad de días que el cliente dijo haber estado sin servicio (billing_review_request)." },
            },
            required: ["action"],
          },
        },
      }],
      tool_choice: { type: "function", function: { name: "bpgo_bot_action" } },
    }),
  }).catch(() => null);
  if (!response || !response.ok) return { action: "escalate", reason: "bot_api_error" };
  const payload = await response.json().catch(() => null);
  const toolCall = payload?.choices?.[0]?.message?.tool_calls?.[0];
  if (!toolCall?.function?.arguments) return { action: "escalate", reason: "bot_parse_error" };
  const parsed = (() => { try { return JSON.parse(toolCall.function.arguments); } catch { return null; } })();
  if (!parsed?.action) return { action: "escalate", reason: "bot_parse_error" };
  return parsed;
}

const SPANISH_MONTH_NAMES = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];

function currentBillingMonthEs() {
  return SPANISH_MONTH_NAMES[new Date().getMonth()];
}

// Aplica un pago confirmado por un humano (Carlos/Eduardo tocando el botón de WhatsApp) directamente
// en la facturación real. Solo se llama tras confirmación humana explícita -- nunca desde el bot --
// y solo si hay exactamente un registro de cobranza candidato, para no adivinar a cuál mes/servicio
// corresponde el pago cuando hay ambigüedad.
async function applyPaymentToBillingRecord(env, phone, extractedAmount) {
  const row = await env.DB.prepare("SELECT data FROM app_state WHERE id = 'main'").first();
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
  target.notes = `Pago confirmado por el equipo BPGO vía WhatsApp el ${new Date().toLocaleString("es-CL")}.`;
  target.lastMessageAt = new Date().toISOString();
  await env.DB.prepare("UPDATE app_state SET data = ?, updated_at = datetime('now') WHERE id = 'main'")
    .bind(JSON.stringify(state)).run();
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

async function executeBotAction(env, credentials, phone, action, message) {
  const preferAudio = Boolean(message.preferAudio);
  if (action.action === "reply" && action.text) {
    // Nunca dejar que el bot mencione un monto/descuento cuando el cliente habla de días sin
    // servicio, aunque el modelo lo intente: se reemplaza por la pregunta segura de días sin
    // servicio en vez de confiar en que el prompt alcance para evitarlo siempre.
    const mentionsOutage = /sin internet|sin servicio|sin conexi[oó]n|d[ií]as? sin|corte de (servicio|internet)/i.test(message.customerText || "");
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
    if (caseRow) {
      await env.DB.prepare("UPDATE whatsapp_automation_cases SET case_type='payment', confidence=CASE WHEN confidence < 95 THEN 95 ELSE confidence END, summary='Comprobante de pago identificado para validación.', updated_at=datetime('now') WHERE id=?")
        .bind(caseRow.id).run().catch(() => null);
    }
    if (caseRow && (Number.isFinite(Number(action.extracted_amount)) || action.extracted_date)) {
      await env.DB.prepare(`UPDATE whatsapp_automation_cases SET
        amount = COALESCE(?, amount), service_month = COALESCE(?, service_month), updated_at = datetime('now')
        WHERE id = ?`)
        .bind(Number.isFinite(Number(action.extracted_amount)) ? Math.round(Number(action.extracted_amount)) : null,
          action.extracted_date || null, caseRow.id).run();
    }
    const known = caseRow?.reported_name || await getKnownAccountName(env, phone);
    if (known) {
      if (caseRow && !caseRow.reported_name) {
        await env.DB.prepare("UPDATE whatsapp_automation_cases SET reported_name = ? WHERE id = ?").bind(known, caseRow.id).run();
      }
      await sendBotReply(env, credentials, phone, action.text || "Recibimos tu comprobante, en breve lo revisamos. ¡Gracias! 🙏", preferAudio);
      await notifyStaff(env, credentials, "carlos", "Comprobante de pago", known, phone, "Cliente envió comprobante de pago para revisión.", { caseId: caseRow?.id || null, sourceMessageId: message.messageId });
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
    // El nombre del titular SIEMPRE se pide y se captura por código en el próximo mensaje si
    // no lo conocíamos ya (ver whatsapp_pending_visits en runBotForInboundMessages) -- nunca se
    // confía en que el modelo lo haya preguntado o lo recuerde, para que esto sea predecible.
    await ensureWhatsAppBotTables(env);
    const known = await getKnownAccountName(env, phone);
    if (known) {
      const customer = await findCustomerForWhatsApp(env, phone, message.customerName);
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
    // Igual que en pagos: el bot NUNCA calcula ni menciona un monto de descuento, solo junta
    // los días sin servicio y el nombre del titular para que un humano calcule el ajuste.
    await ensureWhatsAppBotTables(env);
    const days = Number.isFinite(Number(action.days_without_service)) ? Math.round(Number(action.days_without_service)) : null;
    const known = await getKnownAccountName(env, phone);
    if (known) {
      const customer = await findCustomerForWhatsApp(env, phone, message.customerName);
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
    await sendBotReply(env, credentials, phone, action.text || "Ya te comunico con un agente de BPGO, en breve te responde por acá. 🙌", preferAudio);
    const escalatedName = await getKnownAccountName(env, phone);
    await notifyStaff(env, credentials, "carlos", "Conversación escalada", escalatedName, phone, action.reason || "El bot no pudo resolver la consulta.", { sourceMessageId: message.messageId });
    return;
  }
  if (action.action === "new_customer_request") {
    // Todo el flujo de contratación (sector, ubicación, factibilidad, planes) es determinístico
    // desde acá en adelante -- nunca se vuelve a llamar al modelo mientras haya una solicitud
    // en curso (ver el chequeo de whatsapp_sales_leads en runBotForInboundMessages).
    await ensureWhatsAppBotTables(env);
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

async function runBotForInboundMessages(env, changes) {
  if (String(env.WHATSAPP_BOT_ENABLED || "").toLowerCase() !== "true") return;
  const credentials = await getWhatsAppCredentials(env);
  if (!credentials.accessToken || !credentials.phoneNumberId) return;
  for (const change of changes) {
    const value = change.value || {};
    const name = value.contacts?.[0]?.profile?.name || null;
    for (const message of (Array.isArray(value.messages) ? value.messages : [])) {
      const phone = message.from;
      try {
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
        const mode = await getBotSessionMode(env, phone);
        if (mode === "human") {
          // El mensaje ya fue guardado en la bandeja. Mientras un humano tenga la conversación,
          // nunca se llama a la IA ni se responde; solo "Reactivar bot" puede devolverla al bot.
          continue;
        }
        const preferAudio = message.type === "audio";
        let text = message.text?.body || message.button?.text || message.interactive?.button_reply?.title || message.interactive?.list_reply?.title || null;
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
        if (salesLead) {
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
              await sendBotReply(env, credentials, phone, "Necesitamos que nos compartas tu ubicación desde WhatsApp: toca el ícono 📎 (adjuntar) y elige \"Ubicación\". Así podemos revisar la factibilidad exacta.", preferAudio);
            }
            continue;
          }
          if (salesLead.status === "awaiting_factibilidad") {
            await sendBotReply(env, credentials, phone, "Seguimos revisando la factibilidad en tu sector, en breve te contactamos. 🙏", preferAudio);
            continue;
          }
          if (salesLead.status === "awaiting_plan" && String(text || "").trim()) {
            const plan = matchChosenPlan(salesLead.plan_group, text);
            if (plan) {
              await env.DB.prepare("UPDATE whatsapp_sales_leads SET chosen_plan = ?, status = 'awaiting_installation_data', updated_at = datetime('now') WHERE id = ?")
                .bind(`${plan.speed} ($${plan.price})`, salesLead.id).run();
              await sendBotReply(env, credentials, phone, planConfirmationMessage(plan), preferAudio);
              await sendBotReply(env, credentials, phone, INSTALLATION_DATA_REQUEST_MESSAGE, preferAudio);
            } else {
              await sendBotReply(env, credentials, phone, formatPlansMessage(salesLead.plan_group), preferAudio);
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
              await env.DB.prepare(`UPDATE whatsapp_sales_leads SET installation_${fragment.field} = ?, updated_at = datetime('now') WHERE id = ?`)
                .bind(fragment.value, salesLead.id).run();
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
          const reportedName = String(text).trim().slice(0, 200);
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
          const reportedName = String(text).trim().slice(0, 200);
          if (pendingPayment.case_id) {
            await ensureWhatsAppAutomationTable(env);
            await env.DB.prepare("UPDATE whatsapp_automation_cases SET reported_name = ?, updated_at = datetime('now') WHERE id = ?")
              .bind(reportedName, pendingPayment.case_id).run();
          }
          await env.DB.prepare("DELETE FROM whatsapp_pending_payments WHERE phone = ?").bind(phone).run();
          await sendBotReply(env, credentials, phone, `Gracias, dejamos tu comprobante asociado a nombre de ${reportedName}. El equipo lo confirmará pronto. 🙏`, preferAudio);
          await notifyStaff(env, credentials, "carlos", "Comprobante de pago", reportedName, phone, "Cliente envió comprobante de pago para revisión.", { caseId: pendingPayment.case_id || null, sourceMessageId: message.id });
          await setBotSessionMode(env, phone, "human", "case_created_payment");
          continue;
        }
        const pendingBilling = await env.DB.prepare("SELECT days_without_service, reason FROM whatsapp_pending_billing WHERE phone = ?").bind(phone).first();
        if (pendingBilling && String(text || "").trim()) {
          // Mismo mecanismo: el nombre del titular se captura del próximo mensaje, nunca se le
          // pide al modelo que calcule ni mencione un monto de descuento.
          const reportedName = String(text).trim().slice(0, 200);
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
        const mediaId = message.image?.id || message.document?.id || null;
        let media = null;
        if (mediaId) media = await fetchWhatsAppMediaBase64(credentials, mediaId).catch(() => null);
        const context = await buildBotContext(env, phone, name);
        const action = await callBotResponder(env, context, { type: message.type || "unknown", text }, media);
        await executeBotAction(env, credentials, phone, action, { customerName: name, messageId: message.id, preferAudio, customerText: text });
      } catch {
        await setBotSessionMode(env, phone, "human", "bot_exception").catch(() => null);
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

async function saveBusinessAppEchoesAndPauseBot(env, changes) {
  await ensureWhatsAppInboxTable(env);
  let saved = 0;
  for (const change of changes) {
    if (change?.field !== "smb_message_echoes") continue;
    const value = change.value || {};
    const echoes = Array.isArray(value.message_echoes) ? value.message_echoes : [];
    for (const echo of echoes) {
      const phone = normalizeWhatsAppPhone(echo.to);
      if (!phone || !echo.id) continue;
      const text = echo.text?.body || echo.button?.text || echo.interactive?.button_reply?.title || echo.interactive?.list_reply?.title || null;
      const mediaId = echo.image?.id || echo.document?.id || echo.audio?.id || echo.video?.id || null;
      await env.DB.prepare(`INSERT OR IGNORE INTO whatsapp_inbox_messages
        (message_id, phone, direction, message_type, message_text, media_id, created_at, raw_json)
        VALUES (?, ?, 'outbound', ?, ?, ?, ?, ?)`)
        .bind(echo.id, phone, echo.type || "unknown", text, mediaId,
          new Date(Number(echo.timestamp || 0) * 1000).toISOString(), JSON.stringify(echo)).run();
      await setBotSessionMode(env, phone, "human", "manual_whatsapp_reply");
      saved += 1;
    }
  }
  return saved;
}

async function saveInboundWhatsAppMessages(env, changes) {
  await ensureWhatsAppInboxTable(env);
  let saved = 0;
  for (const change of changes) {
    const value = change.value || {};
    const name = value.contacts?.[0]?.profile?.name || null;
    for (const message of (Array.isArray(value.messages) ? value.messages : [])) {
      const text = message.text?.body || message.button?.text || message.interactive?.button_reply?.title || message.interactive?.list_reply?.title || null;
      const mediaId = message.image?.id || message.document?.id || message.audio?.id || message.video?.id || null;
      await env.DB.prepare(`INSERT OR IGNORE INTO whatsapp_inbox_messages
        (message_id, phone, customer_name, direction, message_type, message_text, media_id, created_at, raw_json)
        VALUES (?, ?, ?, 'inbound', ?, ?, ?, ?, ?)`)
        .bind(message.id, message.from, name, message.type || "unknown", text, mediaId, new Date(Number(message.timestamp || 0) * 1000).toISOString(), JSON.stringify(message))
        .run();
      // En handoff humano el webhook conserva el mensaje en la bandeja, pero no lo clasifica ni
      // crea automatizaciones. El operador debe reactivar el bot explícitamente desde Operaciones.
      if (await getBotSessionMode(env, message.from) !== "human") {
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

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

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
      const syncUrl = "https://script.google.com/macros/s/AKfycbxQWG6fkP1_V8quAUCGN0q2kDtHq5nT4kmOXjTtqdkP9kBaEx_KoE0KAwnG39QhxJvd/exec?cortados=1&token=bpgo_sheets_sync_2026_seguro";
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
      }
      const manualEchoesSaved = await saveBusinessAppEchoesAndPauseBot(env, changes).catch(() => 0);
      const messagesSaved = await saveInboundWhatsAppMessages(env, changes).catch(() => 0);
      const botTask = runBotForInboundMessages(env, changes).catch(() => null);
      if (ctx?.waitUntil) ctx.waitUntil(botTask); else await botTask;
      return Response.json({ ok: true, received: statuses.length, messagesSaved, manualEchoesSaved });
    }

    if (url.pathname === "/api/whatsapp/inbox" && request.method === "GET") {
      const session = await readSession(request, env.OPERATIONS_ADMIN_SECRET);
      if (!session) return Response.json({ ok: false, error: "Sesion no autorizada." }, { status: 401 });
      await ensureWhatsAppInboxTable(env);
      await ensureWhatsAppBotTables(env);
      const inboxCredentials = await getWhatsAppCredentials(env);
      if (inboxCredentials.accessToken && inboxCredentials.wabaId) {
        fetch(`https://graph.facebook.com/v25.0/${encodeURIComponent(inboxCredentials.wabaId)}/subscribed_apps`, {
          method: "POST",
          headers: { authorization: `Bearer ${inboxCredentials.accessToken}`, "content-type": "application/json" },
          body: JSON.stringify({ subscribed_fields: ["messages", "smb_message_echoes"] }),
        }).catch(() => null);
      }
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
      await setBotSessionMode(env, phone, "human", "manual_reply", session);
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
        body: JSON.stringify({ subscribed_fields: ["messages", "smb_message_echoes"] }),
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
      });
    }

    if (url.pathname.startsWith("/api/")) {
      url.protocol = "https:";
      url.hostname = STABLE_BACKEND;
      url.port = "";
      return fetch(new Request(url, request));
    }

    const assetResponse = await env.ASSETS.fetch(request);
    if (url.pathname === "/" || url.pathname === "/index.html" || url.pathname === "/assets/index-bulk-v28.js" || url.pathname === "/assets/password-save-v6.js" || url.pathname === "/assets/sheets-resilience-v9.js" || url.pathname === "/assets/mobile-ux-v11.js" || url.pathname === "/assets/billing-mobile-search-v12.js" || url.pathname === "/assets/mobile-tables-v13.js" || url.pathname === "/assets/technician-shifts-v15.js" || url.pathname === "/assets/agenda-shift-guard-v24.js" || url.pathname === "/assets/enterprise-v22.js" || url.pathname === "/assets/planta-externa-entry.js" || url.pathname === "/assets/operations-points-v29.js" || url.pathname === "/assets/whatsapp-onboarding-v43.js" || url.pathname === "/assets/whatsapp-test-v41.js" || url.pathname === "/assets/mobile-v5.css" || url.pathname === "/assets/enterprise-v22.css" || url.pathname === "/assets/operations-points-v29.css" || url.pathname === "/assets/whatsapp-onboarding-v42.css") {
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

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
  const hasReceipt = Boolean(message.mediaId) && ["image", "document"].includes(message.type);
  if (paymentWords || hasReceipt) {
    return {
      type: "payment",
      confidence: paymentWords && hasReceipt ? 96 : hasReceipt ? 82 : 70,
      summary: hasReceipt ? "Comprobante de pago recibido para validación." : "Cliente informa un pago; falta revisar el comprobante.",
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
      return { id: String(customer.id || customer.rut || customer.name || ""), name: customer.name || customer.client || fallbackName || null };
    }
  }
  return { id: null, name: fallbackName || null };
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
      const text = message.text?.body || message.button?.text || message.interactive?.button_reply?.title || message.interactive?.list_reply?.title || null;
      const mediaId = message.image?.id || message.document?.id || message.audio?.id || message.video?.id || null;
      await env.DB.prepare(`INSERT OR IGNORE INTO whatsapp_inbox_messages
        (message_id, phone, customer_name, direction, message_type, message_text, media_id, created_at, raw_json)
        VALUES (?, ?, ?, 'inbound', ?, ?, ?, ?, ?)`)
        .bind(message.id, message.from, name, message.type || "unknown", text, mediaId, new Date(Number(message.timestamp || 0) * 1000).toISOString(), JSON.stringify(message))
        .run();
      await createAutomationCase(env, {
        messageId: message.id,
        phone: message.from,
        customerName: name,
        type: message.type || "unknown",
        text,
        mediaId,
        createdAt: new Date(Number(message.timestamp || 0) * 1000).toISOString(),
      }).catch(() => null);
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

  const endpoint = `https://graph.facebook.com/v23.0/${encodeURIComponent(phoneNumberId)}/messages`;
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
  async fetch(request, env) {
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
      const row = await env.DB.prepare("SELECT data FROM app_state WHERE id = 'main'").first();
      const state = row ? JSON.parse(row.data) : null;
      if (state && Array.isArray(state.users)) {
        state.users = state.users.map((user) => ({ ...user, password: MASKED_PASSWORD }));
      }
      return Response.json({ data: state });
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
      }
      const messagesSaved = await saveInboundWhatsAppMessages(env, changes).catch(() => 0);
      return Response.json({ ok: true, received: statuses.length, messagesSaved });
    }

    if (url.pathname === "/api/whatsapp/inbox" && request.method === "GET") {
      const session = await readSession(request, env.OPERATIONS_ADMIN_SECRET);
      if (!session) return Response.json({ ok: false, error: "Sesion no autorizada." }, { status: 401 });
      await ensureWhatsAppInboxTable(env);
      const rows = await env.DB.prepare(`SELECT message_id, phone, customer_name, direction, message_type,
        message_text, media_id, created_at FROM whatsapp_inbox_messages ORDER BY created_at DESC LIMIT 300`).all();
      return Response.json({ ok: true, messages: rows.results || [] });
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
      const metadataResponse = await fetch(`https://graph.facebook.com/v23.0/${encodeURIComponent(mediaId)}`, {
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
      const rows = await env.DB.prepare(`SELECT id, source_message_id, phone, customer_name, customer_id,
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
      const endpoint = `https://graph.facebook.com/v23.0/${encodeURIComponent(credentials.phoneNumberId)}/messages`;
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
      return Response.json({
        ok: true,
        readyToStart: Boolean(appId && configId && featureType && env.META_APP_SECRET),
        connected: Boolean(credentials.accessToken && credentials.phoneNumberId && credentials.wabaId && credentials.source === "embedded-signup"),
        appId,
        configId,
        featureType,
        businessId: String(env.META_BUSINESS_ID || ""),
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
      let wabaId = String(body.wabaId || "").trim();
      let phoneNumberId = String(body.phoneNumberId || "").trim();
      const appId = String(env.META_APP_ID || "").trim();
      const appSecret = String(env.META_APP_SECRET || "").trim();
      if (!code) return Response.json({ ok: false, error: "Meta no entregó el código de autorización." }, { status: 400 });
      if ((wabaId && !/^\d+$/.test(wabaId)) || (phoneNumberId && !/^\d+$/.test(phoneNumberId))) {
        return Response.json({ ok: false, error: "Meta entregó identificadores inválidos." }, { status: 400 });
      }
      if (!appId || !appSecret || !env.OPERATIONS_ADMIN_SECRET) return Response.json({ ok: false, error: "Faltan secretos de Meta en Cloudflare." }, { status: 409 });

      const tokenUrl = new URL("https://graph.facebook.com/v23.0/oauth/access_token");
      tokenUrl.searchParams.set("client_id", appId);
      tokenUrl.searchParams.set("client_secret", appSecret);
      tokenUrl.searchParams.set("code", code);
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
          const accountsResponse = await fetch(`https://graph.facebook.com/v23.0/${encodeURIComponent(businessId)}/${edge}?fields=id,name&limit=100`, {
            headers: { authorization: `Bearer ${accessToken}` },
          });
          const accountsPayload = await accountsResponse.json().catch(() => ({}));
          if (!accountsResponse.ok) continue;
          for (const account of Array.isArray(accountsPayload.data) ? accountsPayload.data : []) {
            const accountId = String(account.id || "");
            if (!/^\d+$/.test(accountId) || seenWabas.has(accountId)) continue;
            seenWabas.add(accountId);
            const accountNumbersResponse = await fetch(`https://graph.facebook.com/v23.0/${encodeURIComponent(accountId)}/phone_numbers?fields=id,display_phone_number,verified_name,status&limit=100`, {
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

      const numbersResponse = await fetch(`https://graph.facebook.com/v23.0/${encodeURIComponent(wabaId)}/phone_numbers?fields=id,display_phone_number,verified_name`, {
        headers: { authorization: `Bearer ${accessToken}` },
      });
      const numbersPayload = await numbersResponse.json().catch(() => ({}));
      const selectedNumber = Array.isArray(numbersPayload.data) ? numbersPayload.data.find((item) => String(item.id) === phoneNumberId) : null;
      if (!numbersResponse.ok || !selectedNumber) return Response.json({ ok: false, error: numbersPayload.error?.message || "El número no pertenece a la cuenta de WhatsApp autorizada." }, { status: 422 });

      const subscriptionResponse = await fetch(`https://graph.facebook.com/v23.0/${encodeURIComponent(wabaId)}/subscribed_apps`, {
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
      return Response.json({ ok: true, connected: true, displayPhoneNumber: selectedNumber.display_phone_number, verifiedName: selectedNumber.verified_name });
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
        const metaResponse = await fetch(`https://graph.facebook.com/v23.0/${encodeURIComponent(credentials.phoneNumberId)}?fields=verified_name,display_phone_number,quality_rating`, {
          headers: { authorization: `Bearer ${credentials.accessToken}` },
        });
        const meta = await metaResponse.json().catch(() => ({}));
        metaConnection = metaResponse.ok
          ? { ok: true, verifiedName: meta.verified_name, qualityRating: meta.quality_rating }
          : { ok: false, error: meta.error?.message || "Meta rechazo la conexion", errorCode: meta.error?.code };
        if (metaResponse.ok) {
          const templatesResponse = credentials.wabaId ? await fetch(`https://graph.facebook.com/v23.0/${encodeURIComponent(credentials.wabaId)}/message_templates?name=${encodeURIComponent(String(env.WHATSAPP_TEMPLATE_NAME || "").trim())}&fields=name,status,language,category`, {
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


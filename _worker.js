const STABLE_BACKEND = "478e127a.bpgo-operaciones.pages.dev";
const encoder = new TextEncoder();
const MASKED_PASSWORD = "********";

function normalizeWhatsAppPhone(value) {
  let phone = String(value || "").replace(/\D/g, "");
  if (phone.startsWith("0")) phone = phone.slice(1);
  if (phone.length === 9) phone = `56${phone}`;
  return phone;
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

async function sendBillingMessages(request, env) {
  const body = await request.json().catch(() => ({}));
  const records = Array.isArray(body.records) ? body.records.slice(0, 50) : [];
  if (!records.length) {
    return Response.json({ ok: false, error: "No hay destinatarios para enviar." }, { status: 400 });
  }

  const accessToken = String(env.WHATSAPP_ACCESS_TOKEN || "").trim();
  const phoneNumberId = String(env.WHATSAPP_PHONE_NUMBER_ID || "").trim();
  const templateName = String(env.WHATSAPP_TEMPLATE_NAME || "recordatorio_pago_bpgo").trim();
  const languageCode = String(env.WHATSAPP_TEMPLATE_LANGUAGE || "es_CL").trim();
  if (!accessToken || !phoneNumberId || !templateName || !languageCode) {
    return Response.json({ ok: false, error: "Configuracion de WhatsApp incompleta." }, { status: 500 });
  }

  const endpoint = `https://graph.facebook.com/v23.0/${encodeURIComponent(phoneNumberId)}/messages`;
  const results = [];
  for (const record of records) {
    const phone = normalizeWhatsAppPhone(record.phone);
    if (!phone) {
      results.push({ id: record.id, phone, ok: false, error: "Telefono invalido" });
      continue;
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
  const sent = results.filter((item) => item.ok).length;
  return Response.json({ ok: sent === results.length, sent, failed: results.length - sent, results });
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
      const body = await request.json().catch(() => ({}));
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
      return Response.json({ ok: true, received: statuses.length });
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

    if (url.pathname === "/api/whatsapp/status" && request.method === "GET") {
      const checks = [
        "WHATSAPP_ACCESS_TOKEN",
        "WHATSAPP_PHONE_NUMBER_ID",
        "WHATSAPP_TEMPLATE_NAME",
        "WHATSAPP_TEMPLATE_LANGUAGE",
        "WHATSAPP_WEBHOOK_SECRET",
      ].map((key) => ({ key, configured: Boolean(String(env[key] || "").trim()) }));
      let metaConnection = { ok: false, error: "Configuracion incompleta" };
      if (checks[0].configured && checks[1].configured) {
        const metaResponse = await fetch(`https://graph.facebook.com/v23.0/${encodeURIComponent(String(env.WHATSAPP_PHONE_NUMBER_ID).trim())}?fields=verified_name,display_phone_number,quality_rating`, {
          headers: { authorization: `Bearer ${String(env.WHATSAPP_ACCESS_TOKEN).trim()}` },
        });
        const meta = await metaResponse.json().catch(() => ({}));
        metaConnection = metaResponse.ok
          ? { ok: true, verifiedName: meta.verified_name, qualityRating: meta.quality_rating }
          : { ok: false, error: meta.error?.message || "Meta rechazo la conexion", errorCode: meta.error?.code };
        if (metaResponse.ok) {
          const templatesResponse = await fetch(`https://graph.facebook.com/v23.0/1036223895702559/message_templates?name=${encodeURIComponent(String(env.WHATSAPP_TEMPLATE_NAME || "").trim())}&fields=name,status,language,category`, {
            headers: { authorization: `Bearer ${String(env.WHATSAPP_ACCESS_TOKEN).trim()}` },
          });
          const templates = await templatesResponse.json().catch(() => ({}));
          metaConnection.template = templatesResponse.ok
            ? (templates.data?.[0] || null)
            : { error: templates.error?.message || "No se pudo consultar la plantilla", errorCode: templates.error?.code };
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
      });
    }

    if (url.pathname.startsWith("/api/")) {
      url.protocol = "https:";
      url.hostname = STABLE_BACKEND;
      url.port = "";
      return fetch(new Request(url, request));
    }

    const assetResponse = await env.ASSETS.fetch(request);
    if (url.pathname === "/" || url.pathname === "/index.html" || url.pathname === "/assets/index-bulk-v28.js" || url.pathname === "/assets/password-save-v6.js" || url.pathname === "/assets/sheets-resilience-v9.js" || url.pathname === "/assets/mobile-ux-v11.js" || url.pathname === "/assets/billing-mobile-search-v12.js" || url.pathname === "/assets/mobile-tables-v13.js" || url.pathname === "/assets/technician-shifts-v15.js" || url.pathname === "/assets/agenda-shift-guard-v24.js" || url.pathname === "/assets/enterprise-v22.js" || url.pathname === "/assets/planta-externa-entry.js" || url.pathname === "/assets/operations-points-v29.js" || url.pathname === "/assets/mobile-v5.css" || url.pathname === "/assets/enterprise-v22.css" || url.pathname === "/assets/operations-points-v29.css") {
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

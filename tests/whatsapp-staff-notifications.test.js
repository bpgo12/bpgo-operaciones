"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const worker = fs.readFileSync(path.join(root, "_worker.js"), "utf8");
const operations = fs.readFileSync(path.join(root, "assets", "whatsapp-test-v41.js"), "utf8");

assert.match(worker, /idempotency_key/);
assert.match(worker, /pending.*accepted.*sent.*delivered.*read.*failed/s);
assert.match(worker, /idx_staff_notifications_idempotency/);
assert.match(worker, /updateStaffNotificationStatus/);
assert.match(worker, /staff-notifications\/retry/);
assert.match(worker, /aviso_nuevo_pago/);
assert.match(worker, /aviso_factibilidad/);
assert.match(worker, /canFallback = !primaryAccepted && primaryTemplate !== "aviso_nuevo_caso" && primary\.status >= 400/);
assert.match(worker, /canFallback \? await sendTemplate\("aviso_nuevo_caso"\) : null/);
assert.match(worker, /templateName === "aviso_nuevo_pago" && row\.entity_type === "case"/);
assert.match(worker, /original_error_code/);
assert.match(worker, /fallback_message_id/);
assert.match(worker, /JSON\.stringify\(\{ primary: primary\.body, fallback: fallback\?\.body \|\| null \}\)/);
assert.match(worker, /error_subcode/);
assert.match(worker, /fbtrace_id/);
assert.match(worker, /primary_response_json/);
assert.match(worker, /fallback_response_json/);
assert.match(worker, /staff-notifications\/diagnostic/);
assert.match(worker, /staff-notifications\/test/);
assert.match(worker, /name: "aviso_nuevo_caso"/);
assert.match(worker, /Bloqueo de cuenta Meta, no de plantilla/);
assert.match(worker, /visitRequestId: visitRow\?\.id/);
assert.match(worker, /billingRequestId: billingRow\?\.id/);
assert.match(worker, /leadId: salesLead\.id/);
assert.match(worker, /sourceMessageId: message\.messageId/);
assert.doesNotMatch(worker, /SELECT id,role,staff_phone/);
assert.match(operations, /Notificaciones internas/);
assert.match(operations, /Notificación interna fallida/);
assert.match(operations, /data-retry-staff-notification/);
assert.match(operations, /Ver diagnóstico Meta/);
assert.match(operations, /Probar aviso a Carlos/);
assert.match(operations, /Respuesta completa PRIMARY/);
assert.match(operations, /Respuesta completa FALLBACK/);

// Espaciado de avisos: Meta empezó a rechazar plantillas a Carlos por volumen/frecuencia ("healthy
// ecosystem engagement"). notifyStaff ya no dispara siempre al tiro; encola si el último intento a
// ese rol fue hace menos de STAFF_NOTIFICATION_PACING_MS, y flushQueuedStaffNotifications() -- que
// corre sin bloquear en cada webhook de Meta -- va despachando lo pendiente de a uno por rol.
assert.match(worker, /const STAFF_NOTIFICATION_PACING_MS = 90 \* 1000/);
assert.match(worker, /async function flushQueuedStaffNotifications\(env\)/);
assert.match(worker, /if \(Date\.now\(\) - lastAttemptMs < STAFF_NOTIFICATION_PACING_MS\) \{\s*\n\s*return \{ ok: true, status: "queued", queued: true \};/);
assert.match(worker, /const flushTask = flushQueuedStaffNotifications\(env\)\.catch\(\(\) => null\)/);
assert.match(worker, /ctx\.waitUntil\(flushTask\)/);
// El reintento manual desde el panel debe seguir llamando deliverStaffNotification directo (nunca
// pasar por notifyStaff), para que Carlos pueda forzar un envío inmediato sin esperar el espaciado.
const retryRoute = worker.slice(worker.indexOf('staff-notifications/retry'), worker.indexOf('staff-notifications/retry') + 2000);
assert.match(retryRoute, /await deliverStaffNotification\(env, credentials, row\)/);

// Seguimiento de leads de venta (2026-10-01): un cliente con factibilidad confirmada (esperando
// elegir plan o mandar datos de instalación) que queda sin responder se puede "escapar" sin que
// nadie se entere -- corre cada 10 minutos vía OIDC y manda UN recordatorio (nunca repetido) al
// cliente + un aviso a Carlos, comparando contra el último mensaje ENTRANTE real (no contra
// updated_at, que no se mueve si el cliente escribe algo que el bot no logra interpretar).
assert.match(worker, /const SALES_LEAD_FOLLOWUP_AFTER_MS = 20 \* 60 \* 1000/);
assert.match(worker, /const SALES_LEAD_FOLLOWUP_STATUSES = \["awaiting_plan", "awaiting_installation_data"\]/);
assert.match(worker, /ALTER TABLE whatsapp_sales_leads ADD COLUMN followup_sent_at TEXT/);
assert.match(worker, /WHERE phone=\? AND direction='inbound' ORDER BY created_at DESC LIMIT 1/);
assert.match(worker, /UPDATE whatsapp_sales_leads SET followup_sent_at=datetime\('now'\) WHERE id=\? AND followup_sent_at IS NULL/);
assert.match(worker, /if \(!claim\.meta\?\.changes\) continue;[\s\S]{0,400}sendWhatsAppText\(env, credentials, lead\.phone, message\)/);
assert.match(worker, /sourceMessageId: `followup-\$\{lead\.id\}`/);
assert.match(worker, /sales-leads\/follow-up/);
assert.match(worker, /verifySalesFollowUpOidc/);
// El verificador OIDC se generalizó para que cobranza y seguimiento de leads usen el mismo chequeo
// de firma/claims en vez de duplicarlo, pero cada automatización sigue atada a SU PROPIO audience y
// SU PROPIO archivo de workflow -- un token válido para una no debe servir para la otra.
assert.match(worker, /audience: "bpgo-billing-automation", workflowPath: "billing-automation\.yml"/);
assert.match(worker, /audience: "bpgo-sales-followup", workflowPath: "sales-lead-followup\.yml"/);

// Caso real (2026-10-01): Carlos tocaba "Registrar pago" en el aviso de WhatsApp, el pago quedaba
// aplicado y el staff recibía la confirmación -- pero el CLIENTE nunca se enteraba de que su pago
// ya estaba registrado. El botón solo avisaba hacia adentro, nunca hacia afuera.
assert.match(worker, /if \(applied\.ok\) \{[\s\S]{0,1600}Hemos confirmado tu pago\. 🎉 Tu servicio está activo\. Si tienes alguna duda, no dudes en escribirnos\. 😊"\)\.catch\(\(\) => null\);/);

console.log("whatsapp staff notifications: ok");

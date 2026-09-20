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

console.log("whatsapp staff notifications: ok");

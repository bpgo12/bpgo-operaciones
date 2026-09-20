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
assert.match(worker, /visitRequestId: visitRow\?\.id/);
assert.match(worker, /billingRequestId: billingRow\?\.id/);
assert.match(worker, /leadId: salesLead\.id/);
assert.match(worker, /sourceMessageId: message\.messageId/);
assert.doesNotMatch(worker, /SELECT id,role,staff_phone/);
assert.match(operations, /Notificaciones internas/);
assert.match(operations, /Notificación interna fallida/);
assert.match(operations, /data-retry-staff-notification/);

console.log("whatsapp staff notifications: ok");

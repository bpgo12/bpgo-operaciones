"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.join(__dirname, "..");
const worker = fs.readFileSync(path.join(root, "_worker.js"), "utf8");
const inbox = fs.readFileSync(path.join(root, "assets", "whatsapp-test-v41.js"), "utf8");

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

// Reactivación automática (2026-09-30): el usuario pidió explícitamente revertir la regla original
// de "nunca reactivar por tiempo", pero con salvaguardas que el incidente de 84dd2f no tenía:
// 1) solo si un humano tomó la conversación DIRECTAMENTE (nunca si el motivo fue un caso de negocio
//    pendiente de revisión: pago/visita/descuento/contratación siguen esperando reactivación manual).
// 2) el tiempo se cuenta desde la ÚLTIMA actividad real de la conversación, no desde que se activó
//    el modo humano -- para no reactivar mientras un humano sigue escribiendo activamente.
assert.doesNotMatch(worker, /setBotSessionMode\(env, phone, "bot", "auto_reactivated_on_reply"\)/);
assert.match(worker, /const AUTO_REACTIVATABLE_REASONS = new Set\(\["manual_reply", "manual_whatsapp_reply", "manual_takeover"\]\)/);
assert.match(worker, /async function shouldAutoReactivate\(env, phone, session, currentMessageId\)/);
assert.match(worker, /if \(!session \|\| session\.mode !== "human" \|\| !AUTO_REACTIVATABLE_REASONS\.has\(session\.escalation_reason\)\) return false;/);
assert.match(worker, /WHERE phone = \? AND message_id != \? ORDER BY created_at DESC LIMIT 1/);
assert.match(worker, /if \(sessionRow\?\.mode === "human"\) \{[\s\S]*?shouldAutoReactivate[\s\S]*?continue;[\s\S]*?\}/);
assert.match(worker, /if \(await getBotSessionMode\(env, message\.from\) !== "human"\) \{[\s\S]*?createAutomationCase/);
assert.match(worker, /whatsapp_bot_session_events/);
assert.match(worker, /setBotSessionMode\(env, phone, mode, mode === "human" \? "manual_takeover" : "manual_reactivated", session\)/);
assert.match(worker, /setBotSessionMode\(env, phone, "human", "manual_reply", session\)/);
assert.match(worker, /manual_whatsapp_reply/);
assert.match(worker, /extractWhatsAppMessageEchoes/);
assert.match(worker, /isKnownApiOutboundMessage/);
assert.match(inbox, /Tomar conversación/);
assert.match(inbox, /Reactivar bot/);
assert.match(inbox, /data-conversation-mode/);

// Prueba funcional aislada de shouldAutoReactivate con un D1 falso, para verificar la lógica real
// (no solo el texto), incluyendo el caso que 84dd2f no cubría: nunca reactivar un caso de negocio.
const context = { Date, Number, Set };
vm.createContext(context);
vm.runInContext(`
  const AUTO_REACTIVATABLE_REASONS = new Set(["manual_reply", "manual_whatsapp_reply", "manual_takeover"]);
  const AUTO_REACTIVATE_AFTER_MS = 45 * 60 * 1000;
  async ${functionSource("shouldAutoReactivate")}
  this.shouldAutoReactivate = shouldAutoReactivate;
`, context);

function fakeEnv(lastActivityIso) {
  return {
    DB: {
      prepare() {
        return {
          bind() {
            return { async first() { return lastActivityIso ? { created_at: lastActivityIso } : null; } };
          },
        };
      },
    },
  };
}

async function main() {
  const oldIso = new Date(Date.now() - 46 * 60 * 1000).toISOString();
  const recentIso = new Date(Date.now() - 5 * 60 * 1000).toISOString();

  // Motivo manual + suficiente inactividad -> reactiva.
  assert.equal(await context.shouldAutoReactivate(fakeEnv(oldIso), "56900000000", { mode: "human", escalation_reason: "manual_whatsapp_reply" }, "msg1"), true);
  // Motivo manual pero actividad reciente -> NO reactiva (el humano sigue escribiendo).
  assert.equal(await context.shouldAutoReactivate(fakeEnv(recentIso), "56900000000", { mode: "human", escalation_reason: "manual_reply" }, "msg1"), false);
  // Caso de negocio pendiente de revisión -> NUNCA reactiva, sin importar cuánto tiempo pase.
  for (const reason of ["case_created_payment", "case_created_visit", "case_created_billing", "case_created_new_customer", "bot_escalated"]) {
    assert.equal(await context.shouldAutoReactivate(fakeEnv(oldIso), "56900000000", { mode: "human", escalation_reason: reason }, "msg1"), false, `${reason} must never auto-reactivate`);
  }
  // Ya en modo bot -> no aplica.
  assert.equal(await context.shouldAutoReactivate(fakeEnv(oldIso), "56900000000", { mode: "bot", escalation_reason: "manual_reply" }, "msg1"), false);

  console.log("whatsapp human handoff: ok");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

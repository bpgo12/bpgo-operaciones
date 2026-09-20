"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const worker = fs.readFileSync(path.join(root, "_worker.js"), "utf8");
const inbox = fs.readFileSync(path.join(root, "assets", "whatsapp-test-v41.js"), "utf8");

assert.doesNotMatch(worker, /setBotSessionMode\(env, phone, "bot", "auto_reactivated_on_reply"\)/);
assert.match(worker, /if \(mode === "human"\) \{[\s\S]*?continue;[\s\S]*?\}/);
assert.match(worker, /if \(await getBotSessionMode\(env, message\.from\) !== "human"\) \{[\s\S]*?createAutomationCase/);
assert.match(worker, /whatsapp_bot_session_events/);
assert.match(worker, /setBotSessionMode\(env, phone, mode, mode === "human" \? "manual_takeover" : "manual_reactivated", session\)/);
assert.match(worker, /setBotSessionMode\(env, phone, "human", "manual_reply", session\)/);
assert.match(inbox, /Tomar conversación/);
assert.match(inbox, /Reactivar bot/);
assert.match(inbox, /data-conversation-mode/);

console.log("whatsapp human handoff: ok");

// Revisión de la captura de datos de instalación contra TODAS las conversaciones reales (no adivinar casos).
// Descarga de D1 las conversaciones en que se pidieron los datos, las pasa mensaje a mensaje por el lector real de
// _worker.js (igual que el bot) y marca campos sospechosos. El informe (con datos personales) queda en la carpeta temporal
// del sistema, NUNCA en el repositorio.
// Uso (con sesión de Cloudflare):  node scripts/replay-installation-data.mjs
// Correr antes de publicar cualquier cambio al lector; el resultado esperado es "alertas: {}" y revisar el informe.
import { readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const workerPath = join(root, "_worker.js");
const dataPath = join(tmpdir(), "bpgo-datos-instalacion.json");
const outPath = join(tmpdir(), "bpgo-replay-instalacion.txt");
const sql = "WITH pedidos AS (SELECT phone, min(created_at) AS desde FROM whatsapp_inbox_messages WHERE direction='outbound' AND (instr(lower(message_text),'nombre del titular')>0 OR instr(lower(message_text),'rut:')>0) GROUP BY phone) SELECT m.phone, p.desde, m.created_at, m.direction, m.message_type, m.message_text FROM pedidos p JOIN whatsapp_inbox_messages m ON m.phone = p.phone AND m.created_at >= p.desde AND m.created_at <= strftime('%Y-%m-%dT%H:%M:%fZ', p.desde, '+3 days') ORDER BY m.phone, m.created_at";
const npx = process.platform === "win32" ? "npx.cmd" : "npx";
writeFileSync(dataPath, execSync(`${npx} -y wrangler@4 d1 execute bpgo-operaciones-db --remote --json --command "${sql}"`, { cwd: tmpdir(), maxBuffer: 64 * 1024 * 1024 }));

const src = readFileSync(workerPath, "utf8");
function block(startToken) {
  const start = src.indexOf(startToken);
  if (start < 0) throw new Error("no encontrado " + startToken);
  if (startToken.startsWith("const ")) {
    // constante de una línea (regex o arreglo): hasta el ";" que cierra la sentencia de nivel superior
    let depth = 0;
    for (let i = start; i < src.length; i += 1) {
      const c = src[i];
      if (c === "[" || c === "(" || c === "{") depth += 1;
      else if (c === "]" || c === ")" || c === "}") depth -= 1;
      else if (c === ";" && depth === 0) return src.slice(start, i + 1);
    }
  }
  let depth = 0;
  let i = src.indexOf("{", start);
  for (; i < src.length; i += 1) {
    if (src[i] === "{") depth += 1;
    else if (src[i] === "}") { depth -= 1; if (depth === 0) break; }
  }
  return src.slice(start, i + 1);
}
const ctx = {};
vm.runInNewContext([
  "const INSTALLATION_SECTORS =", "const INSTALLATION_ADDRESS_WORDS =", "const INSTALLATION_CHAT_WORDS =",
  "const INSTALLATION_NAME_STOPWORDS =", "const INSTALLATION_LABELS =", "const INSTALLATION_COMMON_WORDS =", "const INSTALLATION_NAME_PARTICLES =",
  "function installationPlain(", "function installationRutCheckDigit(", "function normalizeInstallationRut(", "function normalizeInstallationPhone(",
  "function isInstallationName(", "function isInstallationAddress(", "function classifyInstallationFragment(",
  "function cyberNormalize(", "function looksLikeQuestion(",
].map(block).join("\n") + "\nthis.classifyInstallationFragment = classifyInstallationFragment; this.looksLikeQuestion = looksLikeQuestion;", ctx);

const rows = JSON.parse(readFileSync(dataPath, "utf8"))[0].results;
const byPhone = new Map();
for (const r of rows) {
  if (!byPhone.has(r.phone)) byPhone.set(r.phone, []);
  byPhone.get(r.phone).push(r);
}
const out = [];
const flagsTotal = {};
const flag = (list, code, detail) => { list.push(`${code}: ${detail}`); flagsTotal[code] = (flagsTotal[code] || 0) + 1; };
const phoneLike = (v) => /^(?:\+?56)?9\d{8}$/.test(String(v || "").replace(/[\s().-]/g, ""));
let completas = 0;
for (const [phone, msgs] of byPhone) {
  const lead = { name: null, rut: null, phone: null, email: null, address: null };
  const steps = [];
  const flags = [];
  for (const m of msgs) {
    if (m.direction !== "inbound" || m.message_type !== "text" || !String(m.message_text || "").trim()) continue;
    if (Object.values(lead).every(Boolean)) break; // el bot ya cerró la captura
    const text = m.message_text;
    const frag = ctx.classifyInstallationFragment(text, { name: lead.name, address: lead.address });
    if (frag) Object.assign(lead, frag);
    steps.push({ text, frag });
    for (const line of text.split(/\r?\n/)) {
      const compact = line.replace(/[\s().-]/g, "");
      if (/(?:\+?56)?9\d{8}/.test(compact) && !(frag && frag.phone) && !/@/.test(line)) flag(flags, "TELEFONO_NO_TOMADO", JSON.stringify(line));
      if (/[^\s@]+@[^\s@]+\.[^\s@]+/.test(line) && !(frag && frag.email)) flag(flags, "CORREO_NO_TOMADO", JSON.stringify(line));
      if (/\b\d{1,2}\.?\d{3}\.?\d{3}-[\dkK]\b/.test(line) && !(frag && frag.rut)) flag(flags, "RUT_NO_TOMADO", JSON.stringify(line));
    }
    if (frag && frag.address && (phoneLike(frag.address) || /@/.test(frag.address))) flag(flags, "DIRECCION_INVALIDA", JSON.stringify(frag.address));
    if (frag && frag.name && /\d/.test(frag.name)) flag(flags, "NOMBRE_CON_NUMEROS", JSON.stringify(frag.name));
    if (frag && ctx.looksLikeQuestion(text) && (frag.name || frag.address)) flag(flags, "PREGUNTA_COMO_DATO", JSON.stringify(text.slice(0, 80)));
  }
  if (!steps.length) continue;
  if (Object.values(lead).every(Boolean)) completas += 1;
  out.push(`=== ${phone}  (${steps.length} mensajes procesados)`);
  for (const s of steps) out.push(`  > ${JSON.stringify(s.text).slice(0, 200)}\n      => ${JSON.stringify(s.frag)}`);
  out.push(`  FINAL: ${JSON.stringify(lead)}`);
  if (flags.length) out.push(...flags.map((f) => `  !! ${f}`));
}
writeFileSync(outPath, out.join("\n"), "utf8");
console.log("informe:", outPath);
console.log("conversaciones:", byPhone.size, "| completas:", completas, "| alertas:", JSON.stringify(flagsTotal));

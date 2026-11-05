"use strict";

// Conversación de comprobantes de pago (confirmar -> titular -> revisión) y registro autónomo, contra el Worker real con una base en memoria.
// Todos los datos son inventados.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const workerSource = fs.readFileSync(path.join(__dirname, "..", "_worker.js"), "utf8");
const tmpFile = path.join(os.tmpdir(), `bpgo-worker-receipt-test-${process.pid}.mjs`);
fs.writeFileSync(tmpFile, workerSource);

const MONTHS = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];
const chile = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Santiago", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date())
  .reduce((acc, part) => ({ ...acc, [part.type]: part.value }), {});
const monthIndex = Number(chile.month) - 1;
const currentMonth = MONTHS[monthIndex];
const previousMonth = MONTHS[(monthIndex + 11) % 12];
const todayText = `${chile.day}/${chile.month}/${chile.year}`;

function sheetRows() {
  return [
    ["ID del Cliente", "Nombre del Cliente", "rut", "Dirección", "SECTOR", "Teléfono", "Plan Contratado", "MONTO TOTAL", "Fecha de Registro", previousMonth, currentMonth, "ESTADO BPGO"],
    ["1", "MARIA PEREZ PRUEBA", "11.111.111-1", "A", "Norte", "911110001", "BASICO", "$18.000", "10/01/2025", "PAGADO", "", "ACTIVO"],
    ["2", "JUAN LOPEZ PRUEBA", "22.222.222-2", "A", "Norte", "922220002", "FULL", "$25.000", "10/01/2025", "PAGADO", "SUSPENDIDO", "ACTIVO"],
    ["3", "ANA SOTO PRUEBA", "33.333.333-3", "A", "Sur", "933330003", "BASICO", "$18.000", "10/01/2025", "PAGADO", "PAGADO", "ACTIVO"],
    ["4", "PEDRO DIAZ PRUEBA", "44.444.444-4", "A", "Sur", "944440004", "BASICO", "$18.000", "10/01/2025", "PAGADO", "", "CORTADO"],
    ["5", "LUIS GOMEZ UNO", "55.555.555-5", "A", "Sur", "955550005", "BASICO", "$18.000", "10/01/2025", "PAGADO", "", "ACTIVO"],
    ["6", "LUIS GOMEZ DOS", "66.666.666-6", "A", "Sur", "966660006", "BASICO", "$18.000", "10/01/2025", "PAGADO", "", "ACTIVO"],
  ];
}

let harnessCount = 0;
const realSetTimeout = globalThis.setTimeout;
// El bot espera unos segundos antes de responder (para juntar mensajes seguidos): en la prueba no se espera.
globalThis.setTimeout = (fn, ms, ...rest) => realSetTimeout(fn, 0, ...rest);

async function harness(extraEnv) {
  const { DatabaseSync } = require("node:sqlite");
  harnessCount += 1;
  // Una copia nueva del Worker por caso: el Worker recuerda qué tablas ya creó y cada caso usa una base vacía.
  const worker = (await import("file:///" + tmpFile.replace(/\\/g, "/") + "?v=" + harnessCount)).default;
  const sqlite = new DatabaseSync(":memory:");
  const db = { prepare(sql) {
    const wrap = (args) => ({
      async first() { return sqlite.prepare(sql).get(...args) ?? null; },
      async all() { return { results: sqlite.prepare(sql).all(...args) }; },
      async run() { const info = sqlite.prepare(sql).run(...args); return { meta: { changes: Number(info.changes) }, success: true }; },
    });
    return { bind: (...args) => wrap(args), ...wrap([]) };
  } };
  const rows = sheetRows();
  const sent = [];
  const writes = [];
  let aiAction = null;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    const u = String(url);
    if (u.includes("api.openai.com")) return new Response(JSON.stringify({ choices: [{ message: { tool_calls: [{ function: { arguments: JSON.stringify(aiAction) } }] } }] }), { status: 200 });
    if (u.includes("graph.facebook.com") && u.includes("/messages")) {
      const body = JSON.parse(options.body);
      sent.push({ to: body.to, text: body.type === "template" ? `TEMPLATE ${body.template.name} ${JSON.stringify(body.template.components || [])}` : body.text?.body });
      return new Response(JSON.stringify({ messages: [{ id: `wamid.OUT${sent.length}` }] }), { status: 200 });
    }
    if (u.includes("graph.facebook.com") && /\/(MEDIA1)$/.test(u)) return new Response(JSON.stringify({ url: "https://cdn.example/media1", mime_type: "image/jpeg" }), { status: 200 });
    if (u.startsWith("https://cdn.example")) return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
    if (u.startsWith("https://script.example")) {
      if (options?.method === "POST") {
        const body = JSON.parse(options.body);
        writes.push(body);
        const target = rows.find((row, index) => index > 0 && row[5] === body.phone.slice(-9));
        if (!target) return new Response(JSON.stringify({ ok: false, error: "no encontrado" }), { status: 200 });
        target[10] = "PAGADO";
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: true, rows }), { status: 200 });
    }
    return new Response("{}", { status: 200 });
  };
  const env = {
    DB: db, WHATSAPP_BOT_ENABLED: "true", WHATSAPP_ACCESS_TOKEN: "x", WHATSAPP_PHONE_NUMBER_ID: "1", OPENAI_API_KEY: "k", WHATSAPP_WABA_ID: "1",
    STAFF_PHONE_CARLOS: "56900000001", STAFF_PHONE_EDUARDO: "56900000002", BOT_HOURS: "00:00-23:59", BOT_DAYS: "1-7",
    SHEETS_SCRIPT_URL: "https://script.example/exec", SHEETS_SCRIPT_TOKEN: "t", ...extraEnv,
  };
  const ctx = { tasks: [], waitUntil(p) { this.tasks.push(p); } };
  let counter = 0;
  async function webhook(message) {
    counter += 1;
    const body = { entry: [{ changes: [{ value: { messaging_product: "whatsapp", contacts: [{ profile: { name: "Cliente" } }], messages: [{ timestamp: String(Math.floor(Date.now() / 1000)), id: `wamid.M${counter}`, ...message }] } }] }] };
    const response = await worker.fetch(new Request("https://operaciones.bpgo.cl/api/whatsapp/webhook", { method: "POST", body: JSON.stringify(body) }), env, ctx);
    await Promise.all(ctx.tasks.splice(0));
    return response.status;
  }
  await webhook({ from: "56911119999", type: "text", text: { body: "hola" } });
  sent.length = 0;
  const staffNotices = () => sqlite.prepare("SELECT case_type, summary FROM staff_notifications_log ORDER BY id").all();
  return {
    rows, sent, writes, sqlite, webhook, staffNotices,
    setAi: (value) => { aiAction = value; },
    restore: () => { globalThis.fetch = realFetch; },
    text: (from, body) => webhook({ from, type: "text", text: { body } }),
    image: (from, caption) => webhook({ from, type: "image", image: { id: "MEDIA1", mime_type: "image/jpeg", ...(caption ? { caption } : {}) } }),
    lastTo: (phone) => sent.filter((item) => item.to === phone).map((item) => item.text),
  };
}

const goodReceipt = (overrides) => ({
  action: "payment_ack", text: "ok", extracted_amount: 18000, extracted_date: todayText, transaction_id: "TEFMBCO2611032312126414080880",
  receipt_evidence: ["receipt_title", "bank", "amount", "date_time", "destination_account", "transaction_id"],
  receipt_bank: "Banco Estado", destination_account: "Cuenta Corriente ****6196", destination_bank: "Banco Estado", destination_name: "Consultora y servicios tecnoló",
  receipt_datetime: `${todayText} 23:12 hrs.`, ...overrides,
});

(async () => {
  const client = "56977770001";

  // 1) Modo prueba (por defecto): hace la secuencia completa, decide, avisa y NO escribe en la planilla.
  {
    const h = await harness({});
    h.setAi(goodReceipt());
    await h.image(client);
    assert.match(h.lastTo(client).at(-1), /Recibí la imagen 📎 ¿Es tu comprobante de pago\?/);
    await h.text(client, "Sí, es mi comprobante de pago");
    assert.match(h.lastTo(client).at(-1), /¿a nombre de quién está el servicio\?/);
    await h.text(client, "Maria Perez Prueba");
    assert.match(h.lastTo(client).at(-1), /Gracias, dejamos tu comprobante asociado a nombre de MARIA PEREZ PRUEBA\. El equipo lo confirmará pronto/);
    assert.equal(h.writes.length, 0, "en modo prueba no se escribe en la planilla");
    assert.equal(h.rows[1][10], "", "la planilla sigue sin pagar en modo prueba");
    assert.ok(h.staffNotices().some((notice) => /TODO CUADRA: lo habría registrado solo/.test(notice.summary)));
    h.restore();
  }

  // 2) Modo automático: todo cuadra -> escribe PAGADO, avisa al cliente y a Carlos.
  {
    const h = await harness({ AUTO_PAYMENT_MODE: "auto" });
    h.setAi(goodReceipt());
    await h.image(client);
    await h.text(client, "si");
    await h.text(client, "Maria Perez Prueba");
    assert.equal(h.writes.length, 1);
    assert.equal(h.writes[0].action, "updatePaymentStatus");
    assert.equal(h.writes[0].billingMonth, currentMonth);
    assert.equal(h.rows[1][10], "PAGADO");
    assert.match(h.lastTo(client).at(-1), /¡Listo, Maria! Recibimos tu pago de \$18\.000 y ya quedó registrado ✅/);
    assert.ok(h.staffNotices().some((notice) => /Registrado como PAGADO en la planilla \(fila 2\)/.test(notice.summary)));
    assert.equal(h.sqlite.prepare("SELECT registered FROM receipt_payment_log").get().registered, 1);
    // 2b) El mismo comprobante (misma operación) enviado de nuevo, ahora a otro cliente, NO se registra.
    h.setAi(goodReceipt({ extracted_amount: 18000 }));
    const other = "56977770002";
    await h.image(other);
    await h.text(other, "si");
    await h.text(other, "Luis Gomez Uno");
    assert.equal(h.writes.length, 1, "un número de operación ya usado no se vuelve a registrar");
    assert.ok(h.staffNotices().some((notice) => /el número de operación ya se había usado antes/.test(notice.summary)));
    h.restore();
  }

  // 2c) La fecha impresa como la de los comprobantes reales de Banco Estado ("03 de noviembre del 2026 23:12 hrs.") también se lee.
  {
    const h = await harness({ AUTO_PAYMENT_MODE: "auto" });
    const largo = `${Number(chile.day)} de ${currentMonth} del ${chile.year} 23:12 hrs.`;
    h.setAi(goodReceipt({ extracted_date: largo, receipt_datetime: largo, transaction_id: "TEFLARGO987654" }));
    await h.image(client);
    await h.text(client, "Sí, es mi comprobante de pago");
    await h.text(client, "Maria Perez Prueba");
    assert.equal(h.rows[1][10], "PAGADO");
    h.restore();
  }
  // 3) Cada comprobante que no cuadra pasa a revisión con su motivo y no escribe nada.
  const reviewCases = [
    ["monto distinto", goodReceipt({ extracted_amount: 25000 }), "Maria Perez Prueba", /monto leído \$25\.000, esperado \$18\.000/],
    ["cuenta de otro", goodReceipt({ destination_account: "****9999", destination_bank: "Banco de Chile" }), "Maria Perez Prueba", /la cuenta de destino no es de BPGO/],
    ["fecha antigua", goodReceipt({ receipt_datetime: "01/01/2020 10:00", extracted_date: "01/01/2020" }), "Maria Perez Prueba", /el comprobante es de hace/],
    ["sin operación", goodReceipt({ transaction_id: "" }), "Maria Perez Prueba", /no trae un número de operación legible/],
    ["titular ambiguo", goodReceipt(), "Luis Gomez", /coincide con 2 clientes/],
    ["titular inexistente", goodReceipt(), "Roberto Inventado Nadie", /no encontré a ese titular/],
    ["cliente cortado", goodReceipt(), "Pedro Diaz Prueba", /el cliente figura CORTADO/],
  ];
  for (const [label, action, reported, expected] of reviewCases) {
    const h = await harness({ AUTO_PAYMENT_MODE: "auto" });
    h.setAi(action);
    await h.image(client);
    await h.text(client, "si");
    await h.text(client, reported);
    assert.equal(h.writes.length, 0, `${label}: no debe escribir en la planilla`);
    assert.ok(h.staffNotices().some((notice) => expected.test(notice.summary)), `${label}: el aviso a Carlos debe explicar el motivo`);
    assert.match(h.lastTo(client).at(-1), /dejamos tu comprobante asociado a nombre de/);
    h.restore();
  }

  // 4) Mes ya pagado: no se registra de nuevo, se avisa a Carlos.
  {
    const h = await harness({ AUTO_PAYMENT_MODE: "auto" });
    h.setAi(goodReceipt());
    await h.image(client);
    await h.text(client, "si");
    await h.text(client, "Ana Soto Prueba");
    assert.equal(h.writes.length, 0);
    assert.match(h.lastTo(client).at(-1), /este mes ya figura pagado/);
    assert.ok(h.staffNotices().some((notice) => /posible pago doble/.test(notice.summary)));
    h.restore();
  }

  // 5) Cliente suspendido: se registra y se avisa que hay que reconectar. El cliente puede dar el RUT en vez del nombre.
  {
    const h = await harness({ AUTO_PAYMENT_MODE: "auto" });
    h.setAi(goodReceipt({ extracted_amount: 25000, transaction_id: "OPSUSP123456" }));
    await h.image(client);
    await h.text(client, "así es");
    await h.text(client, "22.222.222-2");
    assert.equal(h.rows[2][10], "PAGADO");
    assert.match(h.lastTo(client).at(-1), /Coordinaremos la reconexión de tu servicio/);
    assert.ok(h.staffNotices().some((notice) => /ESTABA SUSPENDIDO: reconectar el servicio/.test(notice.summary)));
    h.restore();
  }

  // 6) El cliente dice que NO era un comprobante: se corta la secuencia sin escribir nada.
  {
    const h = await harness({ AUTO_PAYMENT_MODE: "auto" });
    h.setAi(goodReceipt());
    await h.image(client);
    await h.text(client, "no, es otra cosa");
    assert.match(h.lastTo(client).at(-1), /¿En qué te puedo ayudar\?/);
    assert.equal(h.sqlite.prepare("SELECT COUNT(*) AS n FROM whatsapp_receipt_flows").get().n, 0);
    assert.equal(h.writes.length, 0);
    h.restore();
  }

  // 7) Si el cliente ya escribió que es un comprobante de pago, se salta la pregunta y se pide el titular.
  {
    const h = await harness({ AUTO_PAYMENT_MODE: "auto" });
    h.setAi(goodReceipt());
    await h.image(client, "Buenas noches adjunto comprobante de pago");
    assert.match(h.lastTo(client).at(-1), /Recibí tu comprobante 🙏 Cuéntanos, ¿a nombre de quién está el servicio\?/);
    h.restore();
  }

  // 8) Interruptor apagado: vuelve al flujo anterior (pide el titular y deja el caso a una persona), sin escribir nada.
  {
    const h = await harness({ AUTO_PAYMENT_MODE: "off" });
    h.setAi(goodReceipt());
    await h.image(client);
    assert.match(h.lastTo(client).at(-1), /¿a nombre de quién está contratado el servicio\?/);
    assert.equal(h.writes.length, 0);
    h.restore();
  }

  // 9) Sin leer la planilla no se registra nada.
  {
    const h = await harness({ AUTO_PAYMENT_MODE: "auto", SHEETS_SCRIPT_URL: "https://caida.example/exec" });
    h.setAi(goodReceipt());
    await h.image(client);
    await h.text(client, "si");
    await h.text(client, "Maria Perez Prueba");
    assert.equal(h.writes.length, 0);
    assert.ok(h.staffNotices().some((notice) => /no pude leer la planilla/.test(notice.summary)));
    h.restore();
  }

  fs.rmSync(tmpFile, { force: true });
  console.log("receipt flow: ok");
})().catch((error) => { fs.rmSync(tmpFile, { force: true }); console.error(error); process.exit(1); });

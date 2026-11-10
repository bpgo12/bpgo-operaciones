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
  let readerAction = { kind: "other" };
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    const u = String(url);
    if (u.includes("api.openai.com") && JSON.parse(options.body).tools?.[0]?.function?.name === "bpgo_read_receipt") return new Response(JSON.stringify({ choices: [{ message: { tool_calls: [{ function: { arguments: JSON.stringify(readerAction) } }] } }] }), { status: 200 });
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
    setReader: (value) => { readerAction = value; },
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

  // 10) Caso real (2026-11-05): la foto del comprobante quedó SIN respuesta de noche y el texto "pago noviembre" llegó aparte. Al responder el texto, la foto se arrastra
  //     y empieza la secuencia del comprobante (en vez de "paga en bpgo.cl/pagar"). Si la foto ya tuvo respuesta, o es muy antigua, no se arrastra.
  {
    const inbox = (h, hoursAgo, direction, type, text) => h.sqlite.prepare("INSERT INTO whatsapp_inbox_messages (message_id, phone, direction, message_type, message_text, media_id, created_at, raw_json) VALUES (?, ?, ?, ?, ?, ?, ?, '{}')")
      .run(`seed-${Math.random()}`, client, direction, type, text, type === "image" ? "MEDIA1" : null, new Date(Date.now() - hoursAgo * 3600000).toISOString());
    const paidText = "Buenas noches pago noviembre";
    {
      const h = await harness({ AUTO_PAYMENT_MODE: "auto" });
      inbox(h, 10, "inbound", "image", "");
      h.setAi(goodReceipt());
      await h.text(client, paidText);
      assert.match(h.lastTo(client).at(-1), /Recibí tu comprobante 🙏 Cuéntanos, ¿a nombre de quién está el servicio?/);
      h.restore();
    }
    {
      const h = await harness({ AUTO_PAYMENT_MODE: "auto" });
      inbox(h, 10, "inbound", "image", "");
      inbox(h, 9, "outbound", "text", "Recibimos tu imagen");
      h.setAi(goodReceipt());
      await h.text(client, paidText);
      assert.doesNotMatch(h.lastTo(client).at(-1), /Cuéntanos, ¿a nombre de quién/);
      h.restore();
    }
    {
      const h = await harness({ AUTO_PAYMENT_MODE: "auto" });
      inbox(h, 30, "inbound", "image", "");
      h.setAi(goodReceipt());
      await h.text(client, paidText);
      assert.doesNotMatch(h.lastTo(client).at(-1), /Cuéntanos, ¿a nombre de quién/);
      h.restore();
    }
    {
      // El aviso de fuera de horario no cuenta como respuesta a la foto.
      const h = await harness({ AUTO_PAYMENT_MODE: "auto" });
      inbox(h, 10, "inbound", "image", "");
      inbox(h, 9.9, "outbound", "text", "Gracias por tu mensaje. Estamos fuera de horario laboral. ⏰ Te responderemos tan pronto como volvamos. 😊");
      h.setAi(goodReceipt());
      await h.text(client, paidText);
      assert.match(h.lastTo(client).at(-1), /Cuéntanos, ¿a nombre de quién está el servicio?/);
      h.restore();
    }
  }

  // 11) Consulta de saldo: pide nombre y RUT, cruza con la planilla y responde con el mes anterior y el vigente, siempre con el enlace de pago.
  {
    const cap = (name) => name.charAt(0).toUpperCase() + name.slice(1);
    const pregunta = "Me podría indicar por favor cuánto es lo que se adeuda";
    const ask = async (h, who, datos) => { await h.text(who, pregunta); await h.text(who, datos); return h.lastTo(who).at(-1); };

    // 11a) Mes anterior pagado, mes vigente pendiente (con nombre y RUT en un solo mensaje).
    {
      const h = await harness({});
      await h.text(client, pregunta);
      assert.match(h.lastTo(client).at(-1), /¿me indicas el nombre del titular del servicio y su RUT?/);
      await h.text(client, "Maria Perez Prueba 11.111.111-1");
      const reply = h.lastTo(client).at(-1);
      assert.match(reply, new RegExp(`${cap(previousMonth)} figura pagado ✅`));
      assert.match(reply, new RegExp(`• ${cap(currentMonth)}: \\$18\\.000 \\(v(ence|enció) el 10\\)`));
      assert.match(reply, /https:\/\/bpgo\.cl\/pagar/);
      assert.equal(h.sqlite.prepare("SELECT COUNT(*) AS n FROM whatsapp_balance_flows").get().n, 0);
      h.restore();
    }
    // 11b) Primero el nombre y luego el RUT, en mensajes separados.
    {
      const h = await harness({});
      await h.text(client, pregunta);
      await h.text(client, "Maria Perez Prueba");
      assert.match(h.lastTo(client).at(-1), /necesito el RUT del titular/);
      await h.text(client, "¿cuánto se adeuda?");
      assert.match(h.lastTo(client).at(-1), /me falta el RUT/);
      await h.text(client, "11.111.111-1");
      assert.match(h.lastTo(client).at(-1), /Esto es lo que figura en tu cuenta/);
      h.restore();
    }
    // 11c) Mes anterior también pendiente: se suman los dos y se muestra el total.
    {
      const h = await harness({});
      h.rows[1][9] = "";
      const reply = await ask(h, client, "Maria Perez Prueba, 11.111.111-1");
      assert.match(reply, new RegExp(`• ${cap(previousMonth)}: \\$18\\.000`));
      assert.match(reply, /Total: \$36\.000/);
      h.restore();
    }
    // 11d) Al día, suspendido, cortado y datos que no cuadran.
    {
      const h = await harness({});
      assert.match(await ask(h, client, "Ana Soto Prueba 33.333.333-3"), /figuran pagados en la planilla/);
      h.restore();
    }
    {
      const h = await harness({});
      const reply = await ask(h, client, "Juan Lopez Prueba 22.222.222-2");
      assert.match(reply, /\$25\.000/);
      assert.match(reply, /suspendido: al pagar coordinamos la reconexión/);
      h.restore();
    }
    {
      const h = await harness({});
      const reply = await ask(h, client, "Pedro Diaz Prueba 44.444.444-4");
      assert.match(reply, /un agente te confirma el detalle en breve/);
      assert.doesNotMatch(reply, /\$\d/);
      assert.equal(h.sqlite.prepare("SELECT mode FROM whatsapp_bot_sessions WHERE phone = ?").get(client).mode, "human");
      h.restore();
    }
    {
      // RUT de una persona y nombre de otra: no se revela nada; tras el segundo intento fallido pasa a un agente.
      const h = await harness({});
      await h.text(client, pregunta);
      await h.text(client, "Ana Soto Prueba 11.111.111-1");
      assert.match(h.lastTo(client).at(-1), /No encontré un servicio con esos datos/);
      await h.text(client, "Ana Soto Prueba 11.111.111-1");
      assert.match(h.lastTo(client).at(-1), /No logré encontrar un servicio con esos datos/);
      assert.ok(h.lastTo(client).every((text) => !/\$\d/.test(text)), "no se debe mostrar ningún monto");
      h.restore();
    }
  }

  // 12) "Necesito cancelar el mes de noviembre": en Chile cancelar es pagar. La respuesta lleva siempre el enlace de pago.
  {
    const h = await harness({});
    await h.text(client, `Necesito cancelar el mes de ${currentMonth}`);
    const reply = h.lastTo(client).at(-1);
    assert.match(reply, /https:\/\/bpgo\.cl\/pagar/);
    assert.doesNotMatch(reply, /más tarde/);
    assert.ok(reply.includes(currentMonth));
    await h.text("56977770009", "Voy a cancelar más tarde, cuando tenga plata");
    const later = h.lastTo("56977770009").at(-1);
    assert.match(later, /https:\/\/bpgo\.cl\/pagar/);
    assert.doesNotMatch(later, /cuando puedas/);
    h.restore();
  }

  {
    const h = await harness({});
    h.setAi(goodReceipt());
    await h.image(client);
    await h.text(client, "es de noviembre");
    assert.match(h.lastTo(client).at(-1), /noviembre.*revisión/);
    assert.equal(h.writes.length, 0);
    assert.equal(h.sqlite.prepare("SELECT mode FROM whatsapp_bot_sessions WHERE phone = ?").get(client).mode, "human");
    h.restore();
  }
  // 13) Un sticker no es un comprobante ni necesita respuesta (caso real 2026-11-09: el bot contestó "Gracias por el comprobante" a un sticker de apretón de manos).
  {
    const h = await harness({});
    h.setAi({ action: "reply", text: "Gracias por el comprobante. Lo revisaremos y te confirmaremos si todo está en orden." });
    await h.webhook({ from: client, type: "sticker", sticker: { id: "STK1", mime_type: "image/webp" } });
    assert.equal(h.lastTo(client).length, 0, "un sticker no debe recibir respuesta");
    h.restore();
  }

  // 14) Si el modelo inventa que recibió un comprobante que nunca llegó, la frase se cambia por una pregunta segura.
  {
    const h = await harness({});
    h.setAi({ action: "reply", text: "Gracias por el comprobante. Lo revisaremos y te confirmaremos si todo está en orden." });
    await h.text(client, "ok de acuerdo, hablamos");
    const reply = h.lastTo(client).at(-1);
    assert.ok(!/Gracias por el comprobante/.test(reply), "no se debe agradecer un comprobante inexistente");
    assert.match(reply, /Si ya pagaste, envíame el comprobante/);
    h.restore();
  }

  // 15) Comprobante RECORTADO (sin título arriba): el modelo general lo dejó pasar como "una imagen cualquiera" (caso real 2026-11-09). El lector dedicado lo reconoce.
  {
    const h = await harness({});
    h.setAi({ action: "reply", text: "Hola, ¿en qué te ayudo?" });
    h.setReader({ kind: "payment_receipt", amount: 18000, date_time: todayText + " 10:23:28", transaction_id: "8036035", bank: "BancoEstado", destination_account: "Cuenta Corriente 39100126196", destination_bank: "BancoEstado", destination_name: "Bp Go", has_origin_account: true, has_title: false });
    await h.image(client);
    assert.match(h.lastTo(client).at(-1), /¿Es tu comprobante de pago\?/);
    assert.ok(!/Recibí tu imagen/.test(h.lastTo(client).at(-1)));
    h.restore();
  }

  // 16) "Hola ahí está el depósito" tras una foto ya acusada: no es "cómo pago" (no se responde monto ni link); se vuelve a mirar la foto.
  {
    const h = await harness({});
    h.setAi({ action: "reply", text: "ok" });
    h.setReader({ kind: "other" });
    await h.image(client);
    assert.match(h.lastTo(client).at(-1), /Recibí tu imagen/);
    h.setReader({ kind: "payment_receipt", amount: 18000, date_time: todayText + " 10:23:28", transaction_id: "8036036", bank: "BancoEstado", destination_account: "Cuenta Corriente 39100126196", destination_bank: "BancoEstado", destination_name: "Bp Go" });
    await h.text(client, "Hola ahí está el depósito");
    const reply = h.lastTo(client).at(-1);
    assert.ok(!/El monto a pagar|bpgo\.cl\/pagar/.test(reply), "no debe responder como si preguntara cómo pagar: " + reply);
    assert.match(reply, /comprobante|a nombre de quién/);
    h.restore();
  }

  // 17) "Ahí está el depósito" sin ninguna foto ni comprobante previo: pide el comprobante, no explica cómo pagar.
  {
    const h = await harness({});
    h.setAi({ action: "reply", text: "ok" });
    await h.text(client, "Hola ahí está el depósito");
    const reply = h.lastTo(client).at(-1);
    assert.ok(!/El monto a pagar|bpgo\.cl\/pagar/.test(reply), reply);
    assert.match(reply, /comprobante \(foto o PDF\)/);
    h.restore();
  }

  // 18) Caso real 2026-11-09: "El pago de <nombre> <RUT>" ya trae el titular; el bot no debe volver a preguntar "¿a nombre de quién?".
  {
    const h = await harness({});
    h.setAi(goodReceipt());
    await h.image(client);
    await h.text(client, "El pago de Maria Perez Prueba 11.111.111-1");
    const reply = h.lastTo(client).at(-1);
    assert.ok(!/a nombre de quién está el servicio/.test(reply), reply);
    assert.match(reply, /dejamos tu comprobante asociado a nombre de MARIA PEREZ PRUEBA/);
    h.restore();
  }

  // 19) Nombre y RUT en dos mensajes seguidos: se leen juntos y el RUT no queda suelto ("¿En qué puedo ayudarte con el número…?").
  {
    const h = await harness({});
    h.setAi(goodReceipt());
    await h.image(client);
    await h.text(client, "si");
    await Promise.all([h.text(client, "Maria Perez Prueba"), h.text(client, "11.111.111-1")]);
    const replies = h.lastTo(client);
    assert.ok(!replies.some((reply) => /En qué puedo ayudarte con el número/.test(reply)), replies.join(" | "));
    assert.ok(replies.some((reply) => /dejamos tu comprobante asociado a nombre de MARIA PEREZ PRUEBA/.test(reply)), replies.join(" | "));
    h.restore();
  }

  // 20) Un RUT suelto justo después de dejar el comprobante es un dato de ese trámite.
  {
    const h = await harness({});
    h.setAi(goodReceipt());
    await h.image(client);
    await h.text(client, "si");
    await h.text(client, "Maria Perez Prueba");
    await h.text(client, "11.111.111-1");
    assert.ok(!h.lastTo(client).some((reply) => /En qué puedo ayudarte con el número/.test(reply)), "un RUT suelto tras el comprobante no es una consulta nueva");
    h.restore();
  }
  // 21) Caso real 2026-11-10: tres mensajes seguidos tras el recordatorio; sin banca en línea se ofrece efectivo en CajaVecina, no se escala.
  {
    const h = await harness({});
    h.setAi({ action: "escalate", text: "Ya te comunico con un agente de BPGO, en breve te responde por acá.", reason: "customer_difficulty_paying" });
    await Promise.all([h.text(client, "Este mes cambio la página para realizar el pago"), h.text(client, "No he podido"), h.text(client, "Ya que yo no tengo acceso a la banca en linea")]);
    const replies = h.lastTo(client);
    assert.equal(replies.length, 1, "una sola respuesta para la ráfaga");
    assert.match(replies[0], /efectivo en cualquier CajaVecina/);
    assert.match(replies[0], /N° de cuenta/);
    assert.doesNotMatch(replies[0], /agente/);
    h.restore();
  }
  // Quien solo dice que no tiene banca en línea en un mensaje también recibe la opción.
  {
    const h = await harness({});
    h.setAi({ action: "escalate", text: "x", reason: "x" });
    await h.text(client, "no tengo acceso a la banca en línea");
    assert.match(h.lastTo(client).at(-1), /CajaVecina/);
    h.restore();
  }
  // "No he podido" sin relación con pagos no activa la respuesta de pago.
  {
    const h = await harness({});
    h.setAi({ action: "reply", text: "Revisemos tu router, ¿qué luces ves?" });
    await h.text(client, "No he podido conectarme desde ayer");
    assert.doesNotMatch(h.lastTo(client).at(-1), /CajaVecina/);
    h.restore();
  }
  fs.rmSync(tmpFile, { force: true });
  console.log("receipt flow: ok");
})().catch((error) => { fs.rmSync(tmpFile, { force: true }); console.error(error); process.exit(1); });

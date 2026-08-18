(function () {
  "use strict";

  var timer = 0;

  function normalizePhone(value) {
    var phone = String(value || "").replace(/\D/g, "");
    if (phone.charAt(0) === "0") phone = phone.slice(1);
    if (phone.length === 9) phone = "56" + phone;
    return phone;
  }

  function isApiView() {
    return Array.from(document.querySelectorAll("h2")).some(function (heading) {
      return /api oficial (lista|pendiente)/i.test(heading.textContent || "");
    });
  }

  function status(panel, message, kind) {
    var output = panel.querySelector("[data-whatsapp-test-status]");
    output.className = "whatsapp-test-status " + (kind || "");
    output.textContent = message;
    output.hidden = false;
  }

  async function sendTest(panel) {
    var input = panel.querySelector("input");
    var button = panel.querySelector("button");
    var phone = normalizePhone(input.value);
    if (phone.length < 11 || phone.slice(0, 2) !== "56") {
      status(panel, "Ingresa un número chileno válido, por ejemplo +56 9 1234 5678.", "error");
      input.focus();
      return;
    }
    if (!window.confirm("Se enviará 1 mensaje de prueba a +" + phone + ". ¿Continuar?")) return;

    button.disabled = true;
    button.textContent = "Enviando prueba…";
    status(panel, "Consultando WhatsApp Cloud API…", "pending");
    try {
      var response = await fetch("/api/whatsapp/send-billing", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ records: [{ id: "prueba-controlada-" + Date.now(), phone: phone }] })
      });
      var data = await response.json().catch(function () { return {}; });
      var result = data.results && data.results[0];
      if (!response.ok || !result || !result.ok) {
        var detail = (result && result.error) || data.error || "Meta rechazó el envío.";
        var code = result && result.errorCode ? " (código " + result.errorCode + ")" : "";
        status(panel, "No se envió: " + detail + code, "error");
        return;
      }
      status(panel, "Meta aceptó la prueba. Esperando confirmación de entrega…", "pending");
      if (result.messageId) await watchDelivery(panel, result.messageId);
    } catch (error) {
      status(panel, "No se pudo completar la prueba: " + (error.message || "error de conexión"), "error");
    } finally {
      button.disabled = false;
      button.textContent = "Enviar 1 prueba";
    }
  }

  async function watchDelivery(panel, messageId) {
    var labels = { accepted: "Aceptado por Meta", sent: "Enviado", delivered: "Entregado al teléfono", read: "Leído", failed: "Fallido" };
    for (var attempt = 0; attempt < 12; attempt += 1) {
      await new Promise(function (resolve) { window.setTimeout(resolve, 2500); });
      var response = await fetch("/api/whatsapp/message-status?id=" + encodeURIComponent(messageId), { cache: "no-store" }).catch(function () { return null; });
      var data = response ? await response.json().catch(function () { return {}; }) : {};
      var message = data.message;
      if (!message) continue;
      if (message.status === "failed") {
        var reason = message.error && (message.error.error_data?.details || message.error.message || message.error.title);
        status(panel, "Falló la entrega: " + (reason || "Meta no informó el motivo") + ". ID: " + messageId, "error");
        return;
      }
      if (message.status === "delivered" || message.status === "read") {
        status(panel, labels[message.status] + ". ID Meta: " + messageId, "success");
        return;
      }
      status(panel, (labels[message.status] || message.status) + ". Esperando entrega al teléfono…", "pending");
    }
    status(panel, "Meta aceptó el mensaje, pero todavía no confirmó su entrega. ID: " + messageId, "pending");
  }

  function getCustomerPhones(data) {
    var customers = Array.isArray(data && data.billingCustomers) ? data.billingCustomers : [];
    var unique = new Map();
    customers.forEach(function (customer, index) {
      if (customer && customer.active === false) return;
      var phone = normalizePhone(customer && (customer.phone || customer.whatsapp || customer.telefono));
      if (phone.length < 11 || phone.slice(0, 2) !== "56") return;
      if (!unique.has(phone)) unique.set(phone, { id: customer.id || "cliente-" + index, phone: phone });
    });
    return Array.from(unique.values());
  }

  async function prepareNumberChange(panel) {
    var campaign = panel.querySelector("[data-number-change-campaign]");
    var button = campaign.querySelector("button");
    var output = campaign.querySelector("[data-number-change-status]");
    button.disabled = true;
    output.className = "whatsapp-test-status pending";
    output.hidden = false;
    output.textContent = "Leyendo el maestro de clientes…";
    try {
      var stateResponse = await fetch("/api/state", { headers: { accept: "application/json" }, cache: "no-store" });
      var payload = await stateResponse.json().catch(function () { return {}; });
      var records = getCustomerPhones(payload.data || {});
      if (!stateResponse.ok || !records.length) throw new Error("No se encontraron teléfonos activos válidos en el maestro.");
      button.dataset.prepared = "true";
      button.textContent = "Enviar alerta a " + records.length + " clientes";
      button.disabled = false;
      campaign._records = records;
      output.className = "whatsapp-test-status success";
      output.textContent = records.length + " teléfonos únicos preparados. La cobranza no será modificada.";
    } catch (error) {
      button.disabled = false;
      output.className = "whatsapp-test-status error";
      output.textContent = error.message || "No se pudo preparar la campaña.";
    }
  }

  async function sendNumberChange(panel) {
    var campaign = panel.querySelector("[data-number-change-campaign]");
    var button = campaign.querySelector("button");
    var output = campaign.querySelector("[data-number-change-status]");
    var records = campaign._records || [];
    if (!records.length) return prepareNumberChange(panel);
    var confirmation = window.prompt("Se enviará la alerta de cambio de número a " + records.length + " clientes únicos. Para confirmar escribe ENVIAR");
    if (String(confirmation || "").trim().toUpperCase() !== "ENVIAR") return;
    button.disabled = true;
    var sent = 0, failed = 0, skipped = 0;
    try {
      for (var start = 0; start < records.length; start += 40) {
        output.className = "whatsapp-test-status pending";
        output.hidden = false;
        output.textContent = "Procesando " + Math.min(start + 40, records.length) + " de " + records.length + "…";
        var response = await fetch("/api/whatsapp/send-billing", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ campaign: "number-change", records: records.slice(start, start + 40) })
        });
        var data = await response.json().catch(function () { return {}; });
        if (!response.ok) throw new Error(data.error || "Meta rechazó el lote.");
        sent += Number(data.sent || 0);
        failed += Number(data.failed || 0);
        skipped += Number(data.skipped || 0);
      }
      output.className = failed ? "whatsapp-test-status error" : "whatsapp-test-status success";
      output.textContent = "Campaña terminada: " + sent + " enviados, " + skipped + " ya enviados anteriormente y " + failed + " fallidos.";
      button.textContent = "Campaña procesada";
    } catch (error) {
      output.className = "whatsapp-test-status error";
      output.textContent = "La campaña se detuvo: " + (error.message || "error de conexión") + ". Puedes reanudarla sin duplicar mensajes.";
      button.disabled = false;
      button.textContent = "Reanudar campaña";
    }
  }

  function escapeHtml(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, function (char) {
      return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char];
    });
  }

  async function loadInbox(panel) {
    var inbox = panel.querySelector("[data-whatsapp-inbox]");
    var list = inbox.querySelector("[data-inbox-list]");
    list.innerHTML = '<div class="whatsapp-test-status pending">Actualizando conversaciones…</div>';
    try {
      var response = await fetch("/api/whatsapp/inbox", { cache: "no-store" });
      var data = await response.json().catch(function () { return {}; });
      if (!response.ok) throw new Error(data.error || "No se pudo abrir la bandeja.");
      var groups = new Map();
      (data.messages || []).forEach(function (message) {
        if (!groups.has(message.phone)) groups.set(message.phone, []);
        groups.get(message.phone).push(message);
      });
      if (!groups.size) {
        list.innerHTML = '<div class="whatsapp-inbox-empty">Todavía no hay mensajes recibidos. Pide a un teléfono de prueba que responda al número BPGO y presiona Actualizar.</div>';
        return;
      }
      list.innerHTML = Array.from(groups.entries()).map(function (entry) {
        var phone = entry[0], messages = entry[1].slice().reverse();
        var name = messages.find(function (item) { return item.customer_name; });
        return '<article class="whatsapp-conversation"><header><div><strong>' + escapeHtml(name && name.customer_name || "+" + phone) + '</strong><small>+' + escapeHtml(phone) + '</small></div><button type="button" class="btn secondary small" data-reply-phone="' + escapeHtml(phone) + '">Responder</button></header><div class="whatsapp-thread">' + messages.map(function (message) {
          var content = message.message_text || (message.media_id ? "Archivo recibido (" + message.message_type + ")" : "Mensaje " + message.message_type);
          return '<div class="whatsapp-bubble ' + (message.direction === "outbound" ? "outbound" : "inbound") + '"><span>' + escapeHtml(content) + '</span><small>' + escapeHtml(new Date(message.created_at).toLocaleString("es-CL")) + '</small></div>';
        }).join("") + '</div></article>';
      }).join("");
    } catch (error) {
      list.innerHTML = '<div class="whatsapp-test-status error">' + escapeHtml(error.message || "Error al cargar mensajes") + '</div>';
    }
  }

  async function replyTo(panel, phone) {
    var text = window.prompt("Escribe la respuesta para +" + phone + ":");
    if (!String(text || "").trim()) return;
    var response = await fetch("/api/whatsapp/reply", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ phone: phone, text: text }) });
    var data = await response.json().catch(function () { return {}; });
    if (!response.ok) window.alert(data.error || "No se pudo enviar la respuesta. Recuerda que los textos libres solo funcionan dentro de las 24 horas desde el mensaje del cliente.");
    await loadInbox(panel);
  }

  function markup() {
    return '<section class="whatsapp-test-panel" data-whatsapp-test-panel>' +
      '<div><p class="eyebrow">Validación segura</p><h3>Prueba controlada</h3>' +
      '<p>Envía <strong>solo un mensaje</strong> con la plantilla aprobada <code>recordatorio_pago_bpgo</code>. El lote completo no se modifica.</p></div>' +
      '<div class="whatsapp-test-controls"><label><span>Número que recibirá la prueba</span>' +
      '<input type="tel" inputmode="tel" autocomplete="tel" placeholder="+56 9 1234 5678"></label>' +
      '<button type="button" class="btn">Enviar 1 prueba</button></div>' +
      '<div class="whatsapp-test-status" data-whatsapp-test-status hidden></div>' +
      '<div class="number-change-campaign" data-number-change-campaign><div><p class="eyebrow">Campaña informativa</p>' +
      '<h3>Nuevo número oficial BPGO</h3><p>Usa la plantilla aprobada <code>nuevo_numero_whatsapp</code> para avisar a los clientes activos. Los teléfonos duplicados se eliminan automáticamente.</p></div>' +
      '<button type="button" class="btn secondary" data-number-change-button>Preparar alerta de cambio de número</button>' +
      '<div class="whatsapp-test-status" data-number-change-status hidden></div></div>' +
      '<div class="whatsapp-inbox" data-whatsapp-inbox><header><div><p class="eyebrow">Atención al cliente</p><h3>Bandeja de mensajes</h3><p>Conversaciones recibidas en el número oficial BPGO.</p></div><button type="button" class="btn secondary" data-refresh-inbox>Actualizar</button></header><div data-inbox-list><div class="whatsapp-inbox-empty">Presiona Actualizar para revisar los mensajes.</div></div></div></section>';
  }

  function install() {
    document.querySelectorAll("[data-whatsapp-test-panel]").forEach(function (panel) {
      if (!isApiView()) panel.remove();
    });
    if (!isApiView() || document.querySelector("[data-whatsapp-test-panel]")) return;
    var card = Array.from(document.querySelectorAll(".api-readiness-card, .panel")).find(function (element) {
      return /api oficial (lista|pendiente)/i.test(element.textContent || "");
    });
    if (!card) return;
    card.insertAdjacentHTML("beforeend", markup());
  }

  document.addEventListener("click", function (event) {
    var refreshInbox = event.target.closest("[data-refresh-inbox]");
    if (refreshInbox) {
      loadInbox(refreshInbox.closest("[data-whatsapp-test-panel]"));
      return;
    }
    var replyButton = event.target.closest("[data-reply-phone]");
    if (replyButton) {
      replyTo(replyButton.closest("[data-whatsapp-test-panel]"), replyButton.dataset.replyPhone);
      return;
    }
    var campaignButton = event.target.closest("[data-number-change-button]");
    if (campaignButton) {
      var campaignPanel = campaignButton.closest("[data-whatsapp-test-panel]");
      if (campaignButton.dataset.prepared === "true") sendNumberChange(campaignPanel);
      else prepareNumberChange(campaignPanel);
      return;
    }
    var button = event.target.closest("[data-whatsapp-test-panel] button");
    if (!button) return;
    sendTest(button.closest("[data-whatsapp-test-panel]"));
  });
  function scan() { clearTimeout(timer); timer = window.setTimeout(install, 80); }
  new MutationObserver(scan).observe(document.documentElement, { childList: true, subtree: true });
  document.addEventListener("DOMContentLoaded", install);
  install();
})();

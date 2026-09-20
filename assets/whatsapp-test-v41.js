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
      var sessions = new Map();
      (data.sessions || []).forEach(function (session) { sessions.set(session.phone, session); });
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
        var session = sessions.get(phone);
        var human = session && session.mode === "human";
        var modeButton = human
          ? '<button type="button" class="btn small" data-conversation-mode="bot" data-mode-phone="' + escapeHtml(phone) + '">Reactivar bot</button>'
          : '<button type="button" class="btn secondary small" data-conversation-mode="human" data-mode-phone="' + escapeHtml(phone) + '">Tomar conversación</button>';
        var modeDetail = human ? 'Atención humana' : 'Bot activo';
        if (session && session.updated_at) modeDetail += ' · ' + new Date(session.updated_at).toLocaleString("es-CL");
        return '<article class="whatsapp-conversation" data-conversation-phone="' + escapeHtml(phone) + '"><header><div><strong>' + escapeHtml(name && name.customer_name || "+" + phone) + '</strong><small>+' + escapeHtml(phone) + '</small><small class="conversation-mode ' + (human ? 'human' : 'bot') + '">' + escapeHtml(modeDetail) + '</small></div><div class="conversation-actions">' + modeButton + '<button type="button" class="btn secondary small" data-reply-phone="' + escapeHtml(phone) + '">Responder</button></div></header><div class="whatsapp-thread">' + messages.map(function (message) {
          var content = message.message_text || (message.media_id ? "Archivo recibido (" + message.message_type + ")" : "Mensaje " + message.message_type);
          var attachment = message.media_id ? '<button type="button" class="btn secondary small" data-media-id="' + escapeHtml(message.media_id) + '">Ver comprobante o archivo</button>' : "";
          return '<div class="whatsapp-bubble ' + (message.direction === "outbound" ? "outbound" : "inbound") + '"><span>' + escapeHtml(content) + '</span>' + attachment + '<small>' + escapeHtml(new Date(message.created_at).toLocaleString("es-CL")) + '</small></div>';
        }).join("") + '</div></article>';
      }).join("");
    } catch (error) {
      list.innerHTML = '<div class="whatsapp-test-status error">' + escapeHtml(error.message || "Error al cargar mensajes") + '</div>';
    }
  }

  function automationLabel(type) {
    return ({ payment: "Pago recibido", technical_fault: "Falla técnica", general: "Consulta general" })[type] || type;
  }

  async function loadAutomation(panel) {
    var list = panel.querySelector("[data-automation-list]");
    list.innerHTML = '<div class="whatsapp-test-status pending">Analizando casos recibidos…</div>';
    try {
      var response = await fetch("/api/whatsapp/automation-cases", { cache: "no-store" });
      var data = await response.json().catch(function () { return {}; });
      if (!response.ok) throw new Error(data.error || "No se pudo abrir la revisión del bot.");
      var cases = (data.cases || []).filter(function (item) { return item.status !== "dismissed"; });
      if (!cases.length) {
        list.innerHTML = '<div class="whatsapp-inbox-empty">Todavía no hay casos sugeridos. Cuando llegue un pago, comprobante o reporte de falla aparecerá aquí.</div>';
        return;
      }
      list.innerHTML = cases.map(function (item) {
        var identified = escapeHtml(item.reported_name || item.customer_name || item.customer_id || "Titular sin identificar");
        var details = [];
        if (item.reported_name && item.customer_name && item.reported_name !== item.customer_name) details.push("En sistema: " + escapeHtml(item.customer_name));
        if (item.service_month) details.push("Período " + escapeHtml(item.service_month));
        if (item.amount) details.push("$" + Number(item.amount).toLocaleString("es-CL"));
        return '<article class="automation-case ' + escapeHtml(item.case_type) + '"><header><div><span class="automation-kind">' + escapeHtml(automationLabel(item.case_type)) + '</span><strong>' + identified + '</strong><small>+' + escapeHtml(item.phone) + ' · confianza ' + escapeHtml(item.confidence) + '%</small></div><span class="automation-state">' + escapeHtml(item.status) + '</span></header><p>' + escapeHtml(item.summary || "Pendiente de revisión") + '</p>' + (details.length ? '<p class="automation-details">' + details.join(" · ") + '</p>' : '') + '<footer><button type="button" class="btn secondary small" data-case-action="dismissed" data-case-id="' + escapeHtml(item.id) + '">Descartar</button><button type="button" class="btn small" data-case-action="reviewing" data-case-id="' + escapeHtml(item.id) + '" data-case-phone="' + escapeHtml(item.phone) + '">Revisar</button></footer></article>';
      }).join("");
    } catch (error) {
      list.innerHTML = '<div class="whatsapp-test-status error">' + escapeHtml(error.message || "Error al cargar los casos") + '</div>';
    }
  }

  async function updateAutomationCase(panel, id, statusValue) {
    var response = await fetch("/api/whatsapp/automation-cases", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: id, status: statusValue })
    });
    var data = await response.json().catch(function () { return {}; });
    if (!response.ok) window.alert(data.error || "No se pudo actualizar el caso.");
    await loadAutomation(panel);
  }

  async function openCaseInInbox(panel, phone) {
    await loadInbox(panel);
    var conversation = panel.querySelector('[data-conversation-phone="' + CSS.escape(phone) + '"]');
    if (!conversation) return;
    conversation.scrollIntoView({ behavior: "smooth", block: "center" });
    conversation.classList.add("highlighted");
    window.setTimeout(function () { conversation.classList.remove("highlighted"); }, 3000);
  }

  async function replyTo(panel, phone) {
    var text = window.prompt("Escribe la respuesta para +" + phone + ":");
    if (!String(text || "").trim()) return;
    var response = await fetch("/api/whatsapp/reply", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ phone: phone, text: text }) });
    var data = await response.json().catch(function () { return {}; });
    if (!response.ok) window.alert(data.error || "No se pudo enviar la respuesta. Recuerda que los textos libres solo funcionan dentro de las 24 horas desde el mensaje del cliente.");
    await loadInbox(panel);
    await loadEscalations(panel);
  }

  async function setConversationMode(panel, phone, mode) {
    var action = mode === "human" ? "tomar la conversación" : "reactivar el bot";
    if (!window.confirm("¿Confirmas que deseas " + action + " para +" + phone + "?")) return;
    var response = await fetch("/api/whatsapp/bot-sessions", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ phone: phone, mode: mode })
    });
    var data = await response.json().catch(function () { return {}; });
    if (!response.ok) {
      window.alert(data.error || "No se pudo cambiar el responsable de la conversación.");
      return;
    }
    await loadInbox(panel);
    await loadEscalations(panel);
  }

  async function openMedia(mediaId) {
    try {
      var response = await fetch("/api/whatsapp/media?id=" + encodeURIComponent(mediaId), { cache: "no-store" });
      if (!response.ok) {
        var data = await response.json().catch(function () { return {}; });
        throw new Error(data.error || "No se pudo abrir el archivo.");
      }
      var blob = await response.blob();
      var objectUrl = URL.createObjectURL(blob);
      window.open(objectUrl, "_blank", "noopener");
      window.setTimeout(function () { URL.revokeObjectURL(objectUrl); }, 60000);
    } catch (error) {
      window.alert(error.message || "No se pudo abrir el archivo recibido.");
    }
  }

  async function loadEscalations(panel) {
    var list = panel.querySelector("[data-escalation-list]");
    list.innerHTML = '<div class="whatsapp-test-status pending">Buscando conversaciones escaladas…</div>';
    try {
      var response = await fetch("/api/whatsapp/bot-sessions", { cache: "no-store" });
      var data = await response.json().catch(function () { return {}; });
      if (!response.ok) throw new Error(data.error || "No se pudo abrir la cola de escalados.");
      var sessions = data.sessions || [];
      if (!sessions.length) {
        list.innerHTML = '<div class="whatsapp-inbox-empty">No hay conversaciones esperando a un agente. El bot está respondiendo normalmente.</div>';
        return;
      }
      list.innerHTML = sessions.map(function (item) {
        return '<article class="automation-case general"><header><div><strong>+' + escapeHtml(item.phone) + '</strong><small>' + escapeHtml(item.escalation_reason || "Motivo no especificado") + ' · ' + escapeHtml(new Date(item.updated_at).toLocaleString("es-CL")) + '</small></div></header><footer><button type="button" class="btn secondary small" data-reply-phone="' + escapeHtml(item.phone) + '">Responder</button><button type="button" class="btn small" data-reactivate-bot="' + escapeHtml(item.phone) + '">Reactivar bot</button></footer></article>';
      }).join("");
    } catch (error) {
      list.innerHTML = '<div class="whatsapp-test-status error">' + escapeHtml(error.message || "Error al cargar escalados") + '</div>';
    }
  }

  async function reactivateBot(panel, phone) {
    var response = await fetch("/api/whatsapp/bot-sessions", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ phone: phone, mode: "bot" }) });
    var data = await response.json().catch(function () { return {}; });
    if (!response.ok) window.alert(data.error || "No se pudo reactivar el bot.");
    await loadEscalations(panel);
  }

  function visitStatusLabel(value) {
    return ({ pending: "Pendiente", scheduled: "Agendada", dismissed: "Descartada" })[value] || value;
  }

  async function loadVisitRequests(panel) {
    var list = panel.querySelector("[data-visit-requests-list]");
    list.innerHTML = '<div class="whatsapp-test-status pending">Buscando solicitudes de visita…</div>';
    try {
      var response = await fetch("/api/whatsapp/visit-requests", { cache: "no-store" });
      var data = await response.json().catch(function () { return {}; });
      if (!response.ok) throw new Error(data.error || "No se pudo abrir las solicitudes de visita.");
      var pending = (data.requests || []).filter(function (item) { return item.status !== "dismissed"; });
      if (!pending.length) {
        list.innerHTML = '<div class="whatsapp-inbox-empty">Todavía no hay solicitudes de visita generadas por el bot.</div>';
        return;
      }
      list.innerHTML = pending.map(function (item) {
        var identified = escapeHtml(item.reported_name || item.customer_name || item.customer_id || "Titular sin identificar");
        var extra = [];
        if (item.reported_name && item.customer_name && item.reported_name !== item.customer_name) extra.push("En sistema: " + escapeHtml(item.customer_name));
        if (item.preferred_date) extra.push("Prefiere: " + escapeHtml(item.preferred_date));
        if (item.reason) extra.push(escapeHtml(item.reason));
        return '<article class="automation-case technical_fault"><header><div><strong>' + identified + '</strong><small>+' + escapeHtml(item.phone) + ' · ' + escapeHtml(new Date(item.created_at).toLocaleString("es-CL")) + '</small></div><span class="automation-state">' + escapeHtml(visitStatusLabel(item.status)) + '</span></header>' + (extra.length ? '<p class="automation-details">' + extra.join(" · ") + '</p>' : '') + '<footer><button type="button" class="btn secondary small" data-visit-action="dismissed" data-visit-id="' + item.id + '">Descartar</button><button type="button" class="btn small" data-visit-action="scheduled" data-visit-id="' + item.id + '">Marcar agendada</button></footer></article>';
      }).join("");
    } catch (error) {
      list.innerHTML = '<div class="whatsapp-test-status error">' + escapeHtml(error.message || "Error al cargar solicitudes") + '</div>';
    }
  }

  async function updateVisitRequest(panel, id, statusValue) {
    var response = await fetch("/api/whatsapp/visit-requests", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: Number(id), status: statusValue }) });
    var data = await response.json().catch(function () { return {}; });
    if (!response.ok) window.alert(data.error || "No se pudo actualizar la solicitud.");
    await loadVisitRequests(panel);
  }

  function billingStatusLabel(value) {
    return ({ pending: "Pendiente", resolved: "Resuelta", dismissed: "Descartada" })[value] || value;
  }

  async function loadBillingRequests(panel) {
    var list = panel.querySelector("[data-billing-requests-list]");
    list.innerHTML = '<div class="whatsapp-test-status pending">Buscando solicitudes de descuento…</div>';
    try {
      var response = await fetch("/api/whatsapp/billing-requests", { cache: "no-store" });
      var data = await response.json().catch(function () { return {}; });
      if (!response.ok) throw new Error(data.error || "No se pudo abrir las solicitudes de descuento.");
      var pending = (data.requests || []).filter(function (item) { return item.status !== "dismissed"; });
      if (!pending.length) {
        list.innerHTML = '<div class="whatsapp-inbox-empty">Todavía no hay solicitudes de descuento por corte generadas por el bot.</div>';
        return;
      }
      list.innerHTML = pending.map(function (item) {
        var identified = escapeHtml(item.reported_name || item.customer_name || item.customer_id || "Titular sin identificar");
        var extra = [];
        if (item.reported_name && item.customer_name && item.reported_name !== item.customer_name) extra.push("En sistema: " + escapeHtml(item.customer_name));
        if (item.days_without_service) extra.push(item.days_without_service + " día(s) sin servicio");
        if (item.reason) extra.push(escapeHtml(item.reason));
        return '<article class="automation-case technical_fault"><header><div><strong>' + identified + '</strong><small>+' + escapeHtml(item.phone) + ' · ' + escapeHtml(new Date(item.created_at).toLocaleString("es-CL")) + '</small></div><span class="automation-state">' + escapeHtml(billingStatusLabel(item.status)) + '</span></header>' + (extra.length ? '<p class="automation-details">' + extra.join(" · ") + '</p>' : '') + '<footer><button type="button" class="btn secondary small" data-billing-action="dismissed" data-billing-id="' + item.id + '">Descartar</button><button type="button" class="btn small" data-billing-action="resolved" data-billing-id="' + item.id + '">Marcar resuelta</button></footer></article>';
      }).join("");
    } catch (error) {
      list.innerHTML = '<div class="whatsapp-test-status error">' + escapeHtml(error.message || "Error al cargar solicitudes") + '</div>';
    }
  }

  async function updateBillingRequest(panel, id, statusValue) {
    var response = await fetch("/api/whatsapp/billing-requests", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: Number(id), status: statusValue }) });
    var data = await response.json().catch(function () { return {}; });
    if (!response.ok) window.alert(data.error || "No se pudo actualizar la solicitud.");
    await loadBillingRequests(panel);
  }

  function salesLeadStatusLabel(value) {
    return ({
      awaiting_sector: "Esperando sector", awaiting_location: "Esperando ubicación",
      awaiting_factibilidad: "Esperando respuesta de factibilidad", awaiting_group_clarification: "Esperando aclarar zona",
      no_factibilidad: "Sin factibilidad", awaiting_plan: "Esperando elección de plan",
      awaiting_installation_data: "Esperando datos de instalación", completed: "Completada", cancelled: "Descartada",
    })[value] || value;
  }

  async function loadSalesLeads(panel) {
    var list = panel.querySelector("[data-sales-leads-list]");
    list.innerHTML = '<div class="whatsapp-test-status pending">Buscando solicitudes de contratación…</div>';
    try {
      var response = await fetch("/api/whatsapp/sales-leads", { cache: "no-store" });
      var data = await response.json().catch(function () { return {}; });
      if (!response.ok) throw new Error(data.error || "No se pudo abrir las solicitudes de contratación.");
      var pending = (data.leads || []).filter(function (item) { return item.status !== "cancelled"; });
      if (!pending.length) {
        list.innerHTML = '<div class="whatsapp-inbox-empty">Todavía no hay solicitudes de contratación generadas por el bot.</div>';
        return;
      }
      list.innerHTML = pending.map(function (item) {
        var identified = escapeHtml(item.installation_name || item.customer_name || "Cliente sin identificar");
        var extra = [];
        if (item.sector) extra.push("Sector: " + escapeHtml(item.sector));
        if (item.chosen_plan) extra.push("Plan: " + escapeHtml(item.chosen_plan));
        if (item.installation_rut) extra.push("RUT: " + escapeHtml(item.installation_rut));
        if (item.installation_phone) extra.push("Tel. instalación: " + escapeHtml(item.installation_phone));
        if (item.installation_email) extra.push("Correo: " + escapeHtml(item.installation_email));
        if (item.installation_address) extra.push("Dirección: " + escapeHtml(item.installation_address));
        if (item.latitude && item.longitude) extra.push('<a href="https://www.google.com/maps?q=' + item.latitude + ',' + item.longitude + '" target="_blank" rel="noopener">Ver ubicación</a>');
        return '<article class="automation-case general"><header><div><strong>' + identified + '</strong><small>+' + escapeHtml(item.phone) + ' · ' + escapeHtml(new Date(item.created_at).toLocaleString("es-CL")) + '</small></div><span class="automation-state">' + escapeHtml(salesLeadStatusLabel(item.status)) + '</span></header>' + (extra.length ? '<p class="automation-details">' + extra.join(" · ") + '</p>' : '') + '<footer><button type="button" class="btn secondary small" data-sales-lead-action="cancelled" data-sales-lead-id="' + escapeHtml(item.id) + '">Descartar</button></footer></article>';
      }).join("");
    } catch (error) {
      list.innerHTML = '<div class="whatsapp-test-status error">' + escapeHtml(error.message || "Error al cargar solicitudes") + '</div>';
    }
  }

  async function updateSalesLead(panel, id, statusValue) {
    var response = await fetch("/api/whatsapp/sales-leads", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: id, status: statusValue }) });
    var data = await response.json().catch(function () { return {}; });
    if (!response.ok) window.alert(data.error || "No se pudo actualizar la solicitud.");
    await loadSalesLeads(panel);
  }

  async function loadFaq(panel) {
    var list = panel.querySelector("[data-faq-list]");
    list.innerHTML = '<div class="whatsapp-test-status pending">Cargando FAQ del bot…</div>';
    try {
      var response = await fetch("/api/whatsapp/bot-faq", { cache: "no-store" });
      var data = await response.json().catch(function () { return {}; });
      if (!response.ok) throw new Error(data.error || "No se pudo abrir la FAQ del bot.");
      var items = data.items || [];
      var defaultNote = !items.length ? '<p class="automation-details">Sin FAQ personalizada, el bot está usando este texto por defecto:<br>' + escapeHtml(data.defaultText || "").replace(/\n/g, "<br>") + '</p>' : "";
      list.innerHTML = defaultNote + items.map(function (item) {
        return '<article class="automation-case general"><header><div><strong>' + escapeHtml(item.key) + '</strong></div></header><p>' + escapeHtml(item.value) + '</p><footer><button type="button" class="btn secondary small" data-delete-faq="' + escapeHtml(item.key) + '">Eliminar</button></footer></article>';
      }).join("");
    } catch (error) {
      list.innerHTML = '<div class="whatsapp-test-status error">' + escapeHtml(error.message || "Error al cargar la FAQ") + '</div>';
    }
  }

  async function saveFaq(panel) {
    var keyInput = panel.querySelector("[data-faq-key]");
    var valueInput = panel.querySelector("[data-faq-value]");
    var key = String(keyInput.value || "").trim();
    var value = String(valueInput.value || "").trim();
    if (!key || !value) { window.alert("Completa la clave y el contenido del FAQ."); return; }
    var response = await fetch("/api/whatsapp/bot-faq", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ key: key, value: value }) });
    var data = await response.json().catch(function () { return {}; });
    if (!response.ok) { window.alert(data.error || "No se pudo guardar el FAQ."); return; }
    keyInput.value = "";
    valueInput.value = "";
    await loadFaq(panel);
  }

  async function deleteFaq(panel, key) {
    var response = await fetch("/api/whatsapp/bot-faq", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ key: key, value: "" }) });
    var data = await response.json().catch(function () { return {}; });
    if (!response.ok) window.alert(data.error || "No se pudo eliminar el FAQ.");
    await loadFaq(panel);
  }

  async function loadStaffNotifications(panel) {
    var list = panel.querySelector("[data-staff-notifications-list]");
    var stats = panel.querySelector("[data-staff-notifications-stats]");
    list.innerHTML = '<div class="whatsapp-test-status pending">Cargando notificaciones internas…</div>';
    try {
      var response = await fetch("/api/whatsapp/staff-notifications", { cache: "no-store" });
      var data = await response.json().catch(function () { return {}; });
      if (!response.ok) throw new Error(data.error || "No se pudieron cargar las notificaciones internas.");
      function summary(role, label) {
        var item = data.stats[role] || { sent: 0, delivered: 0, failed: 0 };
        var configured = data.configured[role] ? "Configurado" : "Configuración faltante";
        return '<article class="automation-case general"><header><div><strong>' + label + '</strong><small>' + configured + '</small></div></header><p class="automation-details">Enviadas: ' + item.sent + ' · Entregadas: ' + item.delivered + ' · Fallidas: ' + item.failed + '</p></article>';
      }
      stats.innerHTML = summary("carlos", "Carlos") + summary("eduardo", "Eduardo");
      if (!(data.failed || []).length) {
        list.innerHTML = '<div class="whatsapp-inbox-empty">No hay notificaciones internas fallidas.</div>';
        return;
      }
      list.innerHTML = data.failed.map(function (item) {
        var reason = item.error_message || item.error_details || (item.error_code ? "Error Meta " + item.error_code : "Error sin detalle");
        return '<article class="automation-case payment_proof"><header><div><strong>Notificación interna fallida · ' + escapeHtml(item.role === "eduardo" ? "Eduardo" : "Carlos") + '</strong><small>' + escapeHtml(item.case_type || "Caso") + ' · ' + escapeHtml(new Date(item.created_at).toLocaleString("es-CL")) + '</small></div><span class="automation-state">Fallida</span></header><p class="automation-details">Cliente: ' + escapeHtml(item.customer_name || "Sin identificar") + ' · Caso: ' + escapeHtml(item.entity_id || "Sin ID") + ' · Motivo: ' + escapeHtml(reason) + '</p><footer><button type="button" class="btn small" data-retry-staff-notification="' + item.id + '">Reintentar</button></footer></article>';
      }).join("");
    } catch (error) {
      list.innerHTML = '<div class="whatsapp-test-status error">' + escapeHtml(error.message || "Error al cargar notificaciones") + '</div>';
    }
  }

  async function retryStaffNotification(panel, id, button) {
    button.disabled = true;
    button.textContent = "Reintentando…";
    var response = await fetch("/api/whatsapp/staff-notifications/retry", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: Number(id) }) });
    var data = await response.json().catch(function () { return {}; });
    if (!response.ok) window.alert(data.error || "No se pudo reintentar la notificación.");
    await loadStaffNotifications(panel);
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
      '<div class="whatsapp-inbox" data-whatsapp-inbox><header><div><p class="eyebrow">Atención al cliente</p><h3>Bandeja de mensajes</h3><p>Conversaciones recibidas en el número oficial BPGO.</p></div><button type="button" class="btn secondary" data-refresh-inbox>Actualizar</button></header><div data-inbox-list><div class="whatsapp-inbox-empty">Presiona Actualizar para revisar los mensajes.</div></div></div>' +
      '<div class="whatsapp-automation" data-staff-notifications><header><div><p class="eyebrow">Control de entrega</p><h3>Notificaciones internas</h3><p>Seguimiento de avisos a Carlos y Eduardo. Los fallos no bloquean la creación del caso.</p></div><button type="button" class="btn secondary" data-refresh-staff-notifications>Actualizar</button></header><div class="automation-list" data-staff-notifications-stats></div><div class="automation-list" data-staff-notifications-list><div class="whatsapp-inbox-empty">Presiona Actualizar para revisar.</div></div></div>' +
      '<div class="whatsapp-automation" data-whatsapp-automation><header><div><p class="eyebrow">Preparación del bot</p><h3>Casos detectados</h3><p>Pagos y fallas sugeridos automáticamente. Ningún caso modifica Cobranza ni crea órdenes sin revisión.</p></div><button type="button" class="btn secondary" data-refresh-automation>Actualizar casos</button></header><div class="automation-list" data-automation-list><div class="whatsapp-inbox-empty">Presiona Actualizar casos para revisar las sugerencias.</div></div></div>' +
      '<div class="whatsapp-automation" data-whatsapp-escalations><header><div><p class="eyebrow">Bot autónomo</p><h3>Conversaciones escaladas</h3><p>El bot dejó de responder estos números porque pidieron un humano, no entendió o falló. Reactívalo cuando lo resuelvas.</p></div><button type="button" class="btn secondary" data-refresh-escalations>Actualizar</button></header><div class="automation-list" data-escalation-list><div class="whatsapp-inbox-empty">Presiona Actualizar para revisar.</div></div></div>' +
      '<div class="whatsapp-automation" data-whatsapp-visit-requests><header><div><p class="eyebrow">Bot autónomo</p><h3>Incidencias y solicitudes de visita</h3><p>El bot solo registra la incidencia con el nombre del titular; un agente debe crear la visita real en Agenda.</p></div><button type="button" class="btn secondary" data-refresh-visit-requests>Actualizar</button></header><div class="automation-list" data-visit-requests-list><div class="whatsapp-inbox-empty">Presiona Actualizar para revisar.</div></div></div>' +
      '<div class="whatsapp-automation" data-whatsapp-billing-requests><header><div><p class="eyebrow">Bot autónomo</p><h3>Solicitudes de descuento por corte</h3><p>El bot nunca calcula ni menciona un monto: solo junta los días sin servicio y el nombre del titular. Un agente debe calcular el ajuste real.</p></div><button type="button" class="btn secondary" data-refresh-billing-requests>Actualizar</button></header><div class="automation-list" data-billing-requests-list><div class="whatsapp-inbox-empty">Presiona Actualizar para revisar.</div></div></div>' +
      '<div class="whatsapp-automation" data-whatsapp-sales-leads><header><div><p class="eyebrow">Bot autónomo</p><h3>Solicitudes de contratación nueva</h3><p>Clientes nuevos que el bot guió por sector, ubicación, factibilidad y plan. Coordina la instalación con los datos reunidos.</p></div><button type="button" class="btn secondary" data-refresh-sales-leads>Actualizar</button></header><div class="automation-list" data-sales-leads-list><div class="whatsapp-inbox-empty">Presiona Actualizar para revisar.</div></div></div>' +
      '<div class="whatsapp-automation" data-whatsapp-faq><header><div><p class="eyebrow">Bot autónomo</p><h3>FAQ del bot</h3><p>Información que el bot usa para responder preguntas de clientes (horarios, planes, direcciones, políticas).</p></div><button type="button" class="btn secondary" data-refresh-faq>Actualizar</button></header><div class="automation-list" data-faq-list><div class="whatsapp-inbox-empty">Presiona Actualizar para revisar.</div></div>' +
      '<div class="whatsapp-test-controls"><label><span>Clave (ej: horario_atencion)</span><input type="text" data-faq-key placeholder="clave_corta"></label><label><span>Contenido</span><input type="text" data-faq-value placeholder="Texto que el bot debe saber"></label><button type="button" class="btn" data-save-faq>Guardar</button></div></div></section>';
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
    var refreshAutomation = event.target.closest("[data-refresh-automation]");
    if (refreshAutomation) {
      loadAutomation(refreshAutomation.closest("[data-whatsapp-test-panel]"));
      return;
    }
    var caseAction = event.target.closest("[data-case-action]");
    if (caseAction) {
      var casePanel = caseAction.closest("[data-whatsapp-test-panel]");
      updateAutomationCase(casePanel, caseAction.dataset.caseId, caseAction.dataset.caseAction);
      if (caseAction.dataset.caseAction === "reviewing" && caseAction.dataset.casePhone) {
        openCaseInInbox(casePanel, caseAction.dataset.casePhone);
      }
      return;
    }
    var refreshInbox = event.target.closest("[data-refresh-inbox]");
    if (refreshInbox) {
      loadInbox(refreshInbox.closest("[data-whatsapp-test-panel]"));
      return;
    }
    var mediaButton = event.target.closest("[data-media-id]");
    if (mediaButton) {
      openMedia(mediaButton.dataset.mediaId);
      return;
    }
    var replyButton = event.target.closest("[data-reply-phone]");
    if (replyButton) {
      replyTo(replyButton.closest("[data-whatsapp-test-panel]"), replyButton.dataset.replyPhone);
      return;
    }
    var refreshStaff = event.target.closest("[data-refresh-staff-notifications]");
    if (refreshStaff) {
      loadStaffNotifications(refreshStaff.closest("[data-whatsapp-test-panel]"));
      return;
    }
    var retryStaff = event.target.closest("[data-retry-staff-notification]");
    if (retryStaff) {
      retryStaffNotification(retryStaff.closest("[data-whatsapp-test-panel]"), retryStaff.dataset.retryStaffNotification, retryStaff);
      return;
    }
    var modeButton = event.target.closest("[data-conversation-mode]");
    if (modeButton) {
      setConversationMode(modeButton.closest("[data-whatsapp-test-panel]"), modeButton.dataset.modePhone, modeButton.dataset.conversationMode);
      return;
    }
    var refreshEscalations = event.target.closest("[data-refresh-escalations]");
    if (refreshEscalations) {
      loadEscalations(refreshEscalations.closest("[data-whatsapp-test-panel]"));
      return;
    }
    var reactivateButton = event.target.closest("[data-reactivate-bot]");
    if (reactivateButton) {
      reactivateBot(reactivateButton.closest("[data-whatsapp-test-panel]"), reactivateButton.dataset.reactivateBot);
      return;
    }
    var refreshVisitRequests = event.target.closest("[data-refresh-visit-requests]");
    if (refreshVisitRequests) {
      loadVisitRequests(refreshVisitRequests.closest("[data-whatsapp-test-panel]"));
      return;
    }
    var visitAction = event.target.closest("[data-visit-action]");
    if (visitAction) {
      updateVisitRequest(visitAction.closest("[data-whatsapp-test-panel]"), visitAction.dataset.visitId, visitAction.dataset.visitAction);
      return;
    }
    var refreshBillingRequests = event.target.closest("[data-refresh-billing-requests]");
    if (refreshBillingRequests) {
      loadBillingRequests(refreshBillingRequests.closest("[data-whatsapp-test-panel]"));
      return;
    }
    var billingAction = event.target.closest("[data-billing-action]");
    if (billingAction) {
      updateBillingRequest(billingAction.closest("[data-whatsapp-test-panel]"), billingAction.dataset.billingId, billingAction.dataset.billingAction);
      return;
    }
    var refreshSalesLeads = event.target.closest("[data-refresh-sales-leads]");
    if (refreshSalesLeads) {
      loadSalesLeads(refreshSalesLeads.closest("[data-whatsapp-test-panel]"));
      return;
    }
    var salesLeadAction = event.target.closest("[data-sales-lead-action]");
    if (salesLeadAction) {
      updateSalesLead(salesLeadAction.closest("[data-whatsapp-test-panel]"), salesLeadAction.dataset.salesLeadId, salesLeadAction.dataset.salesLeadAction);
      return;
    }
    var refreshFaq = event.target.closest("[data-refresh-faq]");
    if (refreshFaq) {
      loadFaq(refreshFaq.closest("[data-whatsapp-test-panel]"));
      return;
    }
    var saveFaqButton = event.target.closest("[data-save-faq]");
    if (saveFaqButton) {
      saveFaq(saveFaqButton.closest("[data-whatsapp-test-panel]"));
      return;
    }
    var deleteFaqButton = event.target.closest("[data-delete-faq]");
    if (deleteFaqButton) {
      deleteFaq(deleteFaqButton.closest("[data-whatsapp-test-panel]"), deleteFaqButton.dataset.deleteFaq);
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

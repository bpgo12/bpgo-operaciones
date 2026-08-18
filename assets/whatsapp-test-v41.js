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

  function markup() {
    return '<section class="whatsapp-test-panel" data-whatsapp-test-panel>' +
      '<div><p class="eyebrow">Validación segura</p><h3>Prueba controlada</h3>' +
      '<p>Envía <strong>solo un mensaje</strong> con la plantilla aprobada <code>recordatorio_pago_bpgo</code>. El lote completo no se modifica.</p></div>' +
      '<div class="whatsapp-test-controls"><label><span>Número que recibirá la prueba</span>' +
      '<input type="tel" inputmode="tel" autocomplete="tel" placeholder="+56 9 1234 5678"></label>' +
      '<button type="button" class="btn">Enviar 1 prueba</button></div>' +
      '<div class="whatsapp-test-status" data-whatsapp-test-status hidden></div></section>';
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
    var button = event.target.closest("[data-whatsapp-test-panel] button");
    if (!button) return;
    sendTest(button.closest("[data-whatsapp-test-panel]"));
  });
  function scan() { clearTimeout(timer); timer = window.setTimeout(install, 80); }
  new MutationObserver(scan).observe(document.documentElement, { childList: true, subtree: true });
  document.addEventListener("DOMContentLoaded", install);
  install();
})();

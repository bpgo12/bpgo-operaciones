(function () {
  "use strict";

  // "Enviar lote por API" (/api/whatsapp/send-billing): el servidor excluye a quienes la planilla marca como
  // CORTADO/SUSPENDIDO, PAGADO, sin monto, etc. (mismas reglas que la cobranza automática). La pantalla solo
  // muestra "X OK, Y fallidos"; este aviso explica cuántos clientes quedaron fuera y por qué.
  var nativeFetch = window.fetch.bind(window);
  var LABELS = {
    inactive_or_suspended: "cortados o suspendidos",
    paid: "con el mes ya pagado",
    month_not_pending: "con el mes no pendiente",
    non_positive_amount: "sin monto",
    duplicate_phone: "con teléfono repetido",
    invalid_phone: "con teléfono inválido",
    pending_receipt: "con comprobante en revisión",
    not_in_sheet: "que no figuran en la planilla"
  };

  function showNotice(text, isError) {
    var old = document.getElementById("billing-send-guard-notice");
    if (old) old.remove();
    var box = document.createElement("div");
    box.id = "billing-send-guard-notice";
    box.setAttribute("role", "status");
    box.style.cssText = "position:fixed;z-index:2147483645;left:50%;bottom:18px;transform:translateX(-50%);max-width:560px;"
      + "padding:13px 16px;border-radius:12px;color:#fff;font:600 14px/1.4 system-ui,sans-serif;box-shadow:0 12px 35px rgba(0,0,0,.28);"
      + "background:" + (isError ? "#8d2626" : "#102f2b") + ";display:flex;gap:12px;align-items:center";
    var span = document.createElement("span");
    span.textContent = text;
    var button = document.createElement("button");
    button.type = "button";
    button.textContent = "Cerrar";
    button.style.cssText = "border:0;border-radius:8px;padding:7px 10px;background:#fff;color:#123b35;font-weight:800;cursor:pointer";
    button.addEventListener("click", function () { box.remove(); });
    box.append(span, button);
    document.body.appendChild(box);
  }

  window.fetch = async function billingSendGuardFetch(input, init) {
    var url = typeof input === "string" ? input : input && input.url;
    var response = await nativeFetch(input, init);
    if (!url || url.indexOf("/api/whatsapp/send-billing") === -1) return response;
    var payload = await response.clone().json().catch(function () { return null; });
    if (!payload) return response;
    if (!response.ok && payload.error) {
      showNotice(payload.error, true);
    } else if (payload.excluded > 0) {
      var parts = Object.keys(payload.excludedByReason || {}).map(function (key) {
        return payload.excludedByReason[key] + " " + (LABELS[key] || key);
      });
      showNotice("Se enviaron " + (payload.sent || 0) + " mensajes. No se enviaron " + payload.excluded
        + " según la planilla: " + parts.join(", ") + ".", false);
    }
    return response;
  };
})();

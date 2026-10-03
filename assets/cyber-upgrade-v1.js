(function () {
  "use strict";
  const endpoint = "/api/whatsapp/cyber-upgrade";
  const esc = (v) => String(v == null ? "" : v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  async function api(method, body) {
    const token = sessionStorage.getItem("bpgo-operaciones-auth-token");
    const response = await fetch(endpoint, { method, cache: "no-store", headers: { authorization: "Bearer " + (token || ""), "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "No se pudo cargar la campaña.");
    return data;
  }
  const labels = { interested: "Interesado · gestionar cambio", human: "Solicita ejecutivo", declined: "Ahora no", converted: "Cambio realizado", expired: "Respuesta fuera de plazo" };
  const exclusionLabels = { invalid_phone: "teléfono inválido", inactive: "cortado", duplicate: "duplicado", installed_after_cutoff: "instalado después del 31 de agosto", installation_date_unknown: "fecha de instalación no reconocida (revisar planilla)" };
  function exclusionSummary(excluded) {
    const counts = {};
    for (const item of excluded) counts[item.reason] = (counts[item.reason] || 0) + 1;
    return Object.keys(counts).map((reason) => counts[reason] + ' ' + (exclusionLabels[reason] || reason)).join(' · ');
  }
  function render(panel, data) {
    panel._data = data;
    const variants = (data.template && data.template.variants) || { image: data.template || {}, text: { status: 'NOT_FOUND' } };
    panel.innerHTML = '<header><div><p class="eyebrow">CAMPAÑAS · WHATSAPP</p><h2>Cyber BP GO</h2><p>Plan Oro 100 Mb/s → Plan Platino 300 Mb/s</p></div><button class="btn" data-cyber="refresh">Actualizar</button></header>' +
      (data.campaign.bannerPath ? '<img class="cyber-banner" src="' + esc(data.campaign.bannerPath) + '" alt="Banner Cyber BP GO">' : '') +
      '<blockquote>' + esc(data.campaign.text).replace(/\n/g, '<br>') + '</blockquote>' +
      '<p><strong>' + (data.open ? 'Vigente' : 'Fuera de vigencia') + '</strong> · 30 de septiembre al 5 de octubre de 2026 · Hora de Chile</p>' +
      '<p>Plantilla con banner: <strong>' + esc(variants.image.status) + '</strong>' + (variants.image.status !== 'NOT_FOUND' && variants.image.matches === false ? ' · El texto aprobado debe coincidir con esta oferta.' : '') +
      '<br>Plantilla de respaldo (solo texto): <strong>' + esc(variants.text.status) + '</strong>' + (variants.text.status !== 'NOT_FOUND' && variants.text.matches === false ? ' · El texto aprobado debe coincidir con esta oferta.' : '') +
      '<br>Se enviará con: <strong>' + (data.template.activeVariant === 'image' ? 'plantilla con banner' : data.template.activeVariant === 'text' ? 'plantilla de respaldo (solo texto)' : 'ninguna aprobada todavía') + '</strong></p>' +
      (data.cortadosCheckFailed ? '<p class="cyber-warning">⚠️ No se pudo verificar la planilla de clientes cortados. No se puede enviar hasta actualizar y confirmar que esto se resuelva.</p>' : '') +
      '<div class="cyber-actions"><button class="btn secondary" data-cyber="template">Solicitar aprobación de plantilla</button><button class="btn secondary" data-cyber="templateText">Solicitar plantilla de respaldo (solo texto)</button><span>' + data.eligible.length + ' clientes disponibles' + (data.humanIncluded ? ' (' + data.humanIncluded + ' en atención humana, incluidos)' : '') + (data.excluded.length ? ' · ' + exclusionSummary(data.excluded) + ' excluidos' : '') + '</span></div>' +
      '<p>Revisa y selecciona hasta 20 clientes por lote. Los intentos ya registrados no se repetirán.</p>' +
      '<div class="cyber-batch-actions"><button class="btn secondary" data-cyber="select20">Seleccionar próximos 20</button><button class="btn secondary" data-cyber="clearselection">Limpiar selección</button><span class="cyber-selected-count">0 seleccionados</span></div>' +
      '<div class="cyber-table"><table><thead><tr><th>Enviar</th><th>Cliente</th><th>Teléfono</th><th>Plan actual</th></tr></thead><tbody>' +
      data.eligible.map((c) => '<tr><td><input type="checkbox" aria-label="Seleccionar ' + esc(c.name) + '" value="' + esc(c.phone) + '"></td><td>' + esc(c.name) + '</td><td>' + esc(c.phone) + '</td><td>' + esc(c.plan) + '</td></tr>').join('') +
      '</tbody></table></div><button class="btn" data-cyber="send" ' + (!data.open || !data.template.ready || !data.eligible.length || data.cortadosCheckFailed ? 'disabled' : '') + '>Enviar a seleccionados</button> ' +
      '<button class="btn secondary" data-cyber="sendAll" ' + (!data.open || !data.template.ready || !data.eligible.length || data.cortadosCheckFailed ? 'disabled' : '') + '>Enviar a todos los elegibles (' + data.eligible.length + ', en lotes automáticos de 20)</button>' +
      '<h3>Seguimiento</h3>' +
      (data.sends.some((s) => s.delivery_status === 'failed') ? '<button class="btn secondary" data-cyber="retryFailed">Reintentar fallidos (' + data.sends.filter((s) => s.delivery_status === 'failed').length + ')</button>' : '') +
      '<div class="cyber-table"><table><thead><tr><th>Cliente / teléfono</th><th>Envío</th><th>Respuesta</th><th>Gestión</th></tr></thead><tbody>' +
      data.sends.map((s) => '<tr><td>' + esc(s.customer_name || s.phone) + '</td><td>' + esc(s.message_id ? s.delivery_status || 'Aceptado por Meta' : 'Requiere revisión · no reenviar') + '</td><td>' + esc(labels[s.response] || 'Sin respuesta') + '</td><td>' + (s.response === 'interested' ? '<button class="btn secondary" data-cyber="converted" data-phone="' + esc(s.phone) + '">Marcar cambio realizado</button>' : '—') + '</td></tr>').join('') +
      '</tbody></table></div><p class="cyber-feedback" role="status"></p>';
  }
  async function load(panel) {
    const data = await api("GET");
    render(panel, data);
  }
  function updateSelectedCount(panel) {
    const el = panel.querySelector('.cyber-selected-count');
    if (el) el.textContent = panel.querySelectorAll('.cyber-table input[type=checkbox]:checked').length + ' seleccionados';
  }
  function install() {
    if (document.getElementById("cyber-upgrade-panel")) return;
    const heading = Array.from(document.querySelectorAll("h1,h2")).find((x) => x.textContent.trim() === "Pagos pendientes");
    if (!heading) return;
    const panel = document.createElement("section");
    panel.id = "cyber-upgrade-panel";
    panel.className = "panel";
    panel.innerHTML = '<h2>Cyber BP GO</h2><button class="btn" data-cyber="refresh">Abrir campaña</button><p class="cyber-feedback" role="status"></p>';
    (document.querySelector("main") || heading.parentElement).appendChild(panel);
    panel.addEventListener("change", (event) => {
      if (event.target.matches('.cyber-table input[type=checkbox]')) updateSelectedCount(panel);
    });
    panel.addEventListener("click", async (event) => {
      const button = event.target.closest("[data-cyber]");
      if (!button || panel._busy) return;
      const action = button.dataset.cyber;
      // Estas dos son puramente de la selección en pantalla (no llaman a la API) -- deben resolverse
      // sin pasar por "await load(panel)" al final del bloque try, que re-renderiza la tabla entera
      // y borraría justo la selección que se acaba de hacer.
      if (action === "select20" || action === "clearselection") {
        const boxes = Array.from(panel.querySelectorAll('.cyber-table input[type=checkbox]'));
        boxes.forEach((box, index) => { box.checked = action === "select20" && index < 20; });
        updateSelectedCount(panel);
        return;
      }
      panel._busy = true;
      button.disabled = true;
      try {
        if (action === "template") await api("POST", { action: "template" });
        if (action === "templateText") await api("POST", { action: "template", variant: "text" });
        if (action === "send") {
          const phones = Array.from(panel.querySelectorAll('input:checked')).map((x) => x.value);
          if (!phones.length || phones.length > 20) throw new Error("Selecciona entre 1 y 20 clientes.");
          if (!window.confirm("Enviar esta promoción por WhatsApp a " + phones.length + " clientes seleccionados?")) return;
          const result = await api("POST", { action: "send", confirm: panel._data.campaign.id, previewId: panel._data.previewId, phones });
          await load(panel);
          panel.querySelector('.cyber-feedback').textContent = result.results.filter((x) => x.status === 'accepted').length + ' aceptados por Meta; ' + result.results.filter((x) => x.status === 'review_required').length + ' requieren revisión; ' + result.results.filter((x) => x.status === 'skipped').length + ' omitidos.';
          return;
        }
        if (action === "sendAll") {
          const total = panel._data.eligible.length;
          if (!total) throw new Error("No hay clientes elegibles para enviar.");
          const batches = Math.ceil(total / 20);
          if (!window.confirm("Esto enviará la promoción a los " + total + " clientes elegibles, en " + batches + " lotes automáticos de hasta 20. ¿Continuar?")) return;
          // El backend solo acepta hasta 20 destinatarios por llamada (ver sendCyberCampaign) -- acá
          // se encadenan los lotes solos, pero cada envío sigue siendo una llamada real a Meta, así
          // que se espera un poco entre lotes para no disparar el límite de "healthy ecosystem
          // engagement" que ya afectó los avisos a Carlos (ver STAFF_NOTIFICATION_PACING_MS).
          let accepted = 0, review = 0, skipped = 0, data = panel._data;
          while (data.eligible.length) {
            const phones = data.eligible.slice(0, 20).map((c) => c.phone);
            const result = await api("POST", { action: "send", confirm: data.campaign.id, previewId: data.previewId, phones });
            accepted += result.results.filter((x) => x.status === "accepted").length;
            review += result.results.filter((x) => x.status === "review_required").length;
            skipped += result.results.filter((x) => x.status === "skipped").length;
            panel.querySelector(".cyber-feedback").textContent = "Enviando... " + (accepted + review + skipped) + "/" + total + " procesados.";
            data = await api("GET");
            if (data.eligible.length) await new Promise((resolve) => setTimeout(resolve, 2000));
          }
          render(panel, data);
          panel.querySelector(".cyber-feedback").textContent = accepted + " aceptados por Meta en total; " + review + " requieren revisión; " + skipped + " omitidos.";
          return;
        }
        if (action === "retryFailed") {
          const result = await api("POST", { action: "retryFailed" });
          await load(panel);
          panel.querySelector(".cyber-feedback").textContent = result.freed + " clientes liberados para reintento (ya no cuentan como 'ya intentado').";
          return;
        }
        if (action === "converted") {
          if (!window.confirm("¿El cambio de plan ya fue realizado? Esta marca solo registra la gestión.")) return;
          const result = await api("PATCH", { action: "converted", phone: button.dataset.phone });
          if (!result.ok) throw new Error("La solicitud cambió. Actualiza el panel.");
        }
        await load(panel);
      } catch (error) { panel.querySelector('.cyber-feedback').textContent = error.message; }
      finally { panel._busy = false; button.disabled = false; }
    });
  }
  new MutationObserver(install).observe(document.documentElement, { childList: true, subtree: true });
  document.addEventListener("DOMContentLoaded", install);
  install();
})();

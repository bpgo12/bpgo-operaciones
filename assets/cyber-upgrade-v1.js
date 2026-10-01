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
  const exclusionLabels = { invalid_phone: "teléfono inválido", inactive: "cortado", duplicate: "duplicado", installed_after_cutoff: "instalado después del corte o sin instalación finalizada" };
  function exclusionSummary(excluded) {
    const counts = {};
    for (const item of excluded) counts[item.reason] = (counts[item.reason] || 0) + 1;
    return Object.keys(counts).map((reason) => counts[reason] + ' ' + (exclusionLabels[reason] || reason)).join(' · ');
  }
  function render(panel, data) {
    panel._data = data;
    panel.innerHTML = '<header><div><p class="eyebrow">CAMPAÑAS · WHATSAPP</p><h2>Cyber BP GO</h2><p>Plan Oro 100 Mb/s → Plan Platino 300 Mb/s</p></div><button class="btn" data-cyber="refresh">Actualizar</button></header>' +
      '<blockquote>' + esc(data.campaign.text).replace(/\n/g, '<br>') + '</blockquote>' +
      '<p><strong>' + (data.open ? 'Vigente' : 'Fuera de vigencia') + '</strong> · 30 de septiembre al 5 de octubre de 2026 · Hora de Chile</p>' +
      '<p>Plantilla Meta: <strong>' + esc(data.template.status) + '</strong>' + (data.template.matches === false ? ' · El texto aprobado debe coincidir con esta oferta.' : '') + '</p>' +
      (data.cortadosCheckFailed ? '<p class="cyber-warning">⚠️ No se pudo verificar la planilla de clientes cortados. No se puede enviar hasta actualizar y confirmar que esto se resuelva.</p>' : '') +
      '<div class="cyber-actions"><button class="btn secondary" data-cyber="template">Solicitar aprobación de plantilla</button><span>' + data.eligible.length + ' clientes disponibles · ' + data.humanExcluded + ' en atención humana excluidos' + (data.excluded.length ? ' · ' + exclusionSummary(data.excluded) + ' excluidos' : '') + '</span></div>' +
      '<p>Revisa y selecciona hasta 20 clientes por lote. Los intentos ya registrados no se repetirán.</p>' +
      '<div class="cyber-table"><table><thead><tr><th>Enviar</th><th>Cliente</th><th>Teléfono</th><th>Plan actual</th></tr></thead><tbody>' +
      data.eligible.map((c) => '<tr><td><input type="checkbox" aria-label="Seleccionar ' + esc(c.name) + '" value="' + esc(c.phone) + '"></td><td>' + esc(c.name) + '</td><td>' + esc(c.phone) + '</td><td>' + esc(c.plan) + '</td></tr>').join('') +
      '</tbody></table></div><button class="btn" data-cyber="send" ' + (!data.open || !data.template.ready || !data.eligible.length || data.cortadosCheckFailed ? 'disabled' : '') + '>Enviar a seleccionados</button>' +
      '<h3>Seguimiento</h3><div class="cyber-table"><table><thead><tr><th>Cliente / teléfono</th><th>Envío</th><th>Respuesta</th><th>Gestión</th></tr></thead><tbody>' +
      data.sends.map((s) => '<tr><td>' + esc(s.customer_name || s.phone) + '</td><td>' + esc(s.message_id ? s.delivery_status || 'Aceptado por Meta' : 'Requiere revisión · no reenviar') + '</td><td>' + esc(labels[s.response] || 'Sin respuesta') + '</td><td>' + (s.response === 'interested' ? '<button class="btn secondary" data-cyber="converted" data-phone="' + esc(s.phone) + '">Marcar cambio realizado</button>' : '—') + '</td></tr>').join('') +
      '</tbody></table></div><p class="cyber-feedback" role="status"></p>';
  }
  async function load(panel) {
    const data = await api("GET");
    render(panel, data);
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
    panel.addEventListener("click", async (event) => {
      const button = event.target.closest("[data-cyber]");
      if (!button || panel._busy) return;
      panel._busy = true;
      button.disabled = true;
      try {
        const action = button.dataset.cyber;
        if (action === "template") await api("POST", { action: "template" });
        if (action === "send") {
          const phones = Array.from(panel.querySelectorAll('input:checked')).map((x) => x.value);
          if (!phones.length || phones.length > 20) throw new Error("Selecciona entre 1 y 20 clientes.");
          if (!window.confirm("Enviar esta promoción por WhatsApp a " + phones.length + " clientes seleccionados?")) return;
          const result = await api("POST", { action: "send", confirm: panel._data.campaign.id, previewId: panel._data.previewId, phones });
          await load(panel);
          panel.querySelector('.cyber-feedback').textContent = result.results.filter((x) => x.status === 'accepted').length + ' aceptados por Meta; ' + result.results.filter((x) => x.status === 'review_required').length + ' requieren revisión; ' + result.results.filter((x) => x.status === 'skipped').length + ' omitidos.';
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

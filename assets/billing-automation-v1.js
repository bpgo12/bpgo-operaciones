(function () {
  "use strict";

  const TOKEN_KEY = "bpgo-operaciones-auth-token";

  function authHeaders(json) {
    const headers = new Headers(json ? { "content-type": "application/json" } : {});
    const token = sessionStorage.getItem(TOKEN_KEY);
    if (token) headers.set("authorization", "Bearer " + token);
    return headers;
  }

  function money(value) {
    return Number.isFinite(Number(value)) ? "$" + Number(value).toLocaleString("es-CL") : "—";
  }

  function templateLabel(status) {
    return status === "APPROVED" ? "Aprobada" : status === "PENDING" ? "Pendiente de Meta" : status === "REJECTED" ? "Rechazada" : "No encontrada";
  }

  function countStage(data, stage) {
    return (data.sends || []).filter(function (item) {
      return item.stage === stage && ["accepted", "sent", "delivered", "read"].includes(item.status);
    }).reduce(function (sum, item) { return sum + Number(item.count || 0); }, 0);
  }

  async function api(path, options) {
    const init = Object.assign({}, options || {});
    init.headers = authHeaders(Boolean(init.body));
    const response = await fetch(path, init);
    const payload = await response.json().catch(function () { return {}; });
    if (!response.ok) throw new Error(payload.error || "No se pudo completar la operación.");
    return payload;
  }

  function render(panel, data) {
    panel.querySelector(".billing-auto-content").innerHTML =
      '<div class="billing-auto-head"><div><p class="eyebrow">Automatización segura</p><h2>Cobranza automática</h2>' +
      '<p class="muted">Revalida Google Sheets antes de cada envío. Días 20, 22 y 23 (hora de Chile).</p></div>' +
      '<button class="btn billing-auto-refresh" type="button">Actualizar</button></div>' +
      '<div class="billing-auto-kpis">' +
      '<span><strong>' + (data.pending == null ? "—" : data.pending) + '</strong>Pendientes actuales</span>' +
      '<span><strong>' + countStage(data, "day20") + '</strong>Enviados día 20</span>' +
      '<span><strong>' + countStage(data, "day22") + '</strong>Enviados día 22</span>' +
      '<span><strong>' + countStage(data, "day23") + '</strong>Enviados día 23</span>' +
      '<span><strong>' + (data.excluded == null ? "—" : data.excluded) + '</strong>Excluidos</span>' +
      '<span><strong>' + data.queuePending + '</strong>Pendientes suspensión</span>' +
      '<span><strong>' + money(data.pendingAmount) + '</strong>Monto pendiente</span>' +
      '</div>' +
      (data.sourceFresh ? "" : '<div class="notice danger">Google Sheets no respondió. No se autorizarán envíos automáticos.</div>') +
      '<h3>Estado de plantillas Meta</h3><div class="billing-auto-templates">' +
      (data.templates || []).map(function (item) {
        return '<div><code>' + item.name + '</code><span class="pill ' + (item.status === "APPROVED" ? "done" : item.status === "REJECTED" ? "high" : "review") + '">' + templateLabel(item.status) + '</span>' +
          (item.rejectedReason ? '<small>' + item.rejectedReason + '</small>' : "") + '</div>';
      }).join("") + '</div>' +
      '<details class="billing-auto-test"><summary>Modo prueba</summary><div class="billing-auto-test-row">' +
      '<select aria-label="Etapa de prueba"><option value="day20">Día 20</option><option value="day22">Día 22</option><option value="day23">Día 23</option></select>' +
      '<input aria-label="Teléfono de prueba" placeholder="56912345678" inputmode="numeric">' +
      '<button class="btn secondary billing-auto-test-send" type="button">Enviar prueba</button></div>' +
      '<small>Solo envía al teléfono indicado y registra el envío como prueba.</small></details>' +
      '<h3>Clientes pendientes de suspensión</h3>' +
      '<div class="table-wrap"><table><thead><tr><th>Cliente</th><th>Teléfono</th><th>Sector</th><th>Plan</th><th>Monto</th><th>Estado</th><th>Acciones</th></tr></thead><tbody>' +
      (data.queue || []).map(function (item) {
        return '<tr data-id="' + item.id + '"><td>' + (item.customer_name || "Sin nombre") + '</td><td>' + item.phone + '</td><td>' + (item.sector || "—") + '</td><td>' + (item.plan || "—") + '</td><td>' + money(item.amount) + '</td><td>' + item.status + '</td><td><div class="actions">' +
          '<button class="btn small billing-queue-action" data-status="suspended" type="button">Marcar suspendido</button>' +
          '<button class="btn small secondary billing-queue-action" data-status="paid" type="button">Ya pagó</button>' +
          '<button class="btn small secondary billing-queue-action" data-status="dismissed" type="button">Descartar</button>' +
          '<a class="btn small secondary" target="_blank" rel="noreferrer" href="https://wa.me/' + item.phone + '">Abrir WhatsApp</a>' +
          '</div></td></tr>';
      }).join("") + ((data.queue || []).length ? "" : '<tr><td colspan="7">No hay clientes en la lista del mes.</td></tr>') +
      '</tbody></table></div><div class="billing-auto-message" aria-live="polite"></div>';
  }

  async function load(panel, syncTemplates) {
    const message = panel.querySelector(".billing-auto-message");
    try {
      panel.classList.add("loading");
      if (syncTemplates) await api("/api/billing/automation/templates", { method: "POST", body: "{}" });
      const data = await api("/api/billing/automation", { cache: "no-store" });
      render(panel, data);
    } catch (error) {
      if (message) message.textContent = error.message;
      else panel.querySelector(".billing-auto-content").innerHTML = '<div class="notice danger">' + error.message + '</div>';
    } finally {
      panel.classList.remove("loading");
    }
  }

  function install() {
    if (document.getElementById("billing-automation-panel")) return;
    const heading = Array.from(document.querySelectorAll("h1,h2")).find(function (item) { return item.textContent.trim() === "Pagos pendientes"; });
    if (!heading) return;
    const anchor = heading.closest("section") || heading.parentElement;
    const panel = document.createElement("section");
    panel.id = "billing-automation-panel";
    panel.className = "panel billing-automation-panel";
    panel.innerHTML = '<div class="billing-auto-content"><p>Cargando cobranza automática…</p></div>';
    anchor.insertAdjacentElement("afterend", panel);
    panel.addEventListener("click", async function (event) {
      const refresh = event.target.closest(".billing-auto-refresh");
      if (refresh) return load(panel, true);
      const action = event.target.closest(".billing-queue-action");
      if (action) {
        const row = action.closest("tr");
        try {
          await api("/api/billing/automation/queue", { method: "PATCH", body: JSON.stringify({ id: Number(row.dataset.id), status: action.dataset.status }) });
          await load(panel, false);
        } catch (error) { window.alert(error.message); }
        return;
      }
      const test = event.target.closest(".billing-auto-test-send");
      if (test) {
        const container = test.closest(".billing-auto-test");
        const stage = container.querySelector("select").value;
        const phone = container.querySelector("input").value.trim();
        if (!window.confirm("Enviar SOLO una prueba " + stage + " al teléfono " + phone + "? No se enviará a la cartera.")) return;
        try {
          const result = await api("/api/billing/automation/test", { method: "POST", body: JSON.stringify({ stage: stage, phone: phone }) });
          window.alert(result.ok ? "Prueba aceptada por Meta." : "Meta rechazó la prueba.");
        } catch (error) { window.alert(error.message); }
      }
    });
    load(panel, false);
  }

  new MutationObserver(install).observe(document.documentElement, { childList: true, subtree: true });
  document.addEventListener("DOMContentLoaded", install);
  install();
})();

(function () {
  "use strict";

  const TOKEN_KEY = "bpgo-operaciones-auth-token";
  let active = false;

  function authHeaders(extra) {
    const token = sessionStorage.getItem(TOKEN_KEY) || "";
    return Object.assign({ authorization: "Bearer " + token }, extra || {});
  }

  function escapeHtml(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, function (char) {
      return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" })[char];
    });
  }

  function money(value) {
    return "$" + Number(value || 0).toLocaleString("es-CL");
  }

  function ensureStyles() {
    if (document.getElementById("billing-automation-v1-style")) return;
    const style = document.createElement("style");
    style.id = "billing-automation-v1-style";
    style.textContent = `
      #billing-automation-overlay{position:fixed;inset:0 0 0 260px;background:#f6f7f9;z-index:60;overflow:auto;padding:28px}
      #billing-automation-overlay[hidden]{display:none}
      .ba-head{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;margin-bottom:20px}
      .ba-head h1{margin:3px 0 6px}.ba-head p{margin:0;color:#667085}
      .ba-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px;margin-bottom:18px}
      .ba-kpi,.ba-panel{background:#fff;border:1px solid #e4e7ec;border-radius:14px;padding:16px}
      .ba-kpi span{display:block;color:#667085;font-size:13px}.ba-kpi strong{display:block;font-size:26px;margin-top:5px}
      .ba-panel{margin-bottom:18px}.ba-panel h2{margin:0 0 12px;font-size:18px}
      .ba-table-wrap{overflow:auto}.ba-table{width:100%;border-collapse:collapse;min-width:860px}
      .ba-table th,.ba-table td{padding:10px 8px;border-bottom:1px solid #eef0f2;text-align:left;font-size:13px}
      .ba-table th{color:#667085;font-weight:600}.ba-badge{display:inline-flex;padding:4px 8px;border-radius:999px;background:#f2f4f7;font-size:12px}
      .ba-badge.pending{background:#fff4e5}.ba-badge.suspended{background:#fee4e2}.ba-badge.paid{background:#ecfdf3}
      .ba-actions{display:flex;gap:6px;flex-wrap:wrap}.ba-btn{border:1px solid #d0d5dd;background:#fff;border-radius:8px;padding:7px 10px;cursor:pointer}
      .ba-btn.primary{background:#101828;color:#fff;border-color:#101828}.ba-empty{padding:24px;text-align:center;color:#667085}
      .ba-note{padding:12px 14px;border-radius:10px;background:#f9fafb;color:#475467;font-size:13px;margin-bottom:14px}
      @media(max-width:900px){#billing-automation-overlay{inset:0;padding:18px}.ba-grid{grid-template-columns:repeat(2,1fr)}}
    `;
    document.head.appendChild(style);
  }

  function ensureNav() {
    const nav = document.querySelector(".sidebar .nav");
    if (!nav || nav.querySelector("[data-billing-automation-nav]")) return;
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.billingAutomationNav = "true";
    button.textContent = "Cobranza automática";
    const billing = Array.from(nav.querySelectorAll("button")).find(function (item) {
      return /cobranza/i.test(item.textContent || "") && !item.dataset.billingAutomationNav;
    });
    if (billing && billing.nextSibling) nav.insertBefore(button, billing.nextSibling); else nav.appendChild(button);
  }

  function overlay() {
    let root = document.getElementById("billing-automation-overlay");
    if (root) return root;
    root = document.createElement("div");
    root.id = "billing-automation-overlay";
    root.hidden = true;
    root.innerHTML = '<div class="ba-head"><div><small>COBRANZA</small><h1>Cobranza automática</h1><p>Días 20, 22 y 23 · sincronizada con el estado actual de cobranza.</p></div><div class="ba-actions"><button class="ba-btn" data-ba-refresh>Actualizar</button><button class="ba-btn" data-ba-close>Cerrar</button></div></div><div data-ba-content><div class="ba-empty">Cargando…</div></div>';
    document.body.appendChild(root);
    return root;
  }

  async function api(path, options) {
    const response = await fetch(path, Object.assign({ cache: "no-store" }, options || {}, {
      headers: authHeaders((options && options.headers) || {})
    }));
    const data = await response.json().catch(function () { return {}; });
    if (!response.ok) throw new Error(data.error || "No se pudo cargar la información.");
    return data;
  }

  async function load() {
    const root = overlay();
    const content = root.querySelector("[data-ba-content]");
    content.innerHTML = '<div class="ba-empty">Actualizando cobranza…</div>';
    try {
      const [preview, suspensions, history] = await Promise.all([
        api("/api/billing/automation/preview?ts=" + Date.now()),
        api("/api/billing/automation/suspensions?ts=" + Date.now()),
        api("/api/billing/automation/history?ts=" + Date.now())
      ]);
      const pendingSusp = (suspensions.items || []).filter(function (item) { return item.status === "pending"; });
      const sends = history.items || [];
      const day20 = sends.filter(function (item) { return item.stage === "day20" && item.status !== "failed"; }).length;
      const day22 = sends.filter(function (item) { return item.stage === "day22" && item.status !== "failed"; }).length;
      const day23 = sends.filter(function (item) { return item.stage === "day23" && item.status !== "failed"; }).length;

      const rows = (suspensions.items || []).map(function (item) {
        return '<tr><td><strong>' + escapeHtml(item.customer_name || "Sin nombre") + '</strong><br><small>' + escapeHtml(item.phone || "") + '</small></td>' +
          '<td>' + escapeHtml(item.sector || "—") + '</td><td>' + escapeHtml(item.plan || "—") + '</td><td>' + money(item.amount) + '</td>' +
          '<td><span class="ba-badge ' + escapeHtml(item.status) + '">' + escapeHtml(item.status === "pending" ? "Pendiente de suspensión" : item.status === "suspended" ? "Suspendido" : item.status === "paid" ? "Pagado" : "Descartado") + '</span></td>' +
          '<td><div class="ba-actions">' +
          (item.status === "pending" ? '<button class="ba-btn primary" data-ba-status="suspended" data-id="' + item.id + '">Marcar suspendido</button><button class="ba-btn" data-ba-status="paid" data-id="' + item.id + '">Ya pagó</button><button class="ba-btn" data-ba-status="dismissed" data-id="' + item.id + '">Descartar</button>' : '') +
          '</div></td></tr>';
      }).join("");

      content.innerHTML =
        '<div class="ba-grid">' +
          '<article class="ba-kpi"><span>Pendientes actuales</span><strong>' + Number(preview.totals && preview.totals.eligible || 0) + '</strong></article>' +
          '<article class="ba-kpi"><span>Avisos día 20</span><strong>' + day20 + '</strong></article>' +
          '<article class="ba-kpi"><span>Avisos día 22</span><strong>' + day22 + '</strong></article>' +
          '<article class="ba-kpi"><span>Pendientes suspensión</span><strong>' + pendingSusp.length + '</strong></article>' +
        '</div>' +
        '<section class="ba-panel"><h2>Estado de automatización</h2><div class="ba-note">Cada ejecución vuelve a revisar el estado actual. Pagados, cortados, suspendidos, monto $0 y comprobantes pendientes quedan fuera del envío. Día 23 no suspende automáticamente: prepara esta lista para revisión humana.</div>' +
          '<div class="ba-grid"><article class="ba-kpi"><span>Registros del mes</span><strong>' + Number(preview.totals && preview.totals.records || 0) + '</strong></article><article class="ba-kpi"><span>Elegibles ahora</span><strong>' + Number(preview.totals && preview.totals.eligible || 0) + '</strong></article><article class="ba-kpi"><span>Excluidos</span><strong>' + Number(preview.totals && preview.totals.excluded || 0) + '</strong></article><article class="ba-kpi"><span>Avisos día 23</span><strong>' + day23 + '</strong></article></div></section>' +
        '<section class="ba-panel"><h2>Lista de clientes para suspensión</h2>' +
          (rows ? '<div class="ba-table-wrap"><table class="ba-table"><thead><tr><th>Cliente</th><th>Sector</th><th>Plan</th><th>Monto</th><th>Estado</th><th>Acciones</th></tr></thead><tbody>' + rows + '</tbody></table></div>' : '<div class="ba-empty">Todavía no existe lista de suspensión para este mes.</div>') +
        '</section>';
    } catch (error) {
      content.innerHTML = '<div class="ba-empty">' + escapeHtml(error.message || "No se pudo cargar la cobranza automática.") + '</div>';
    }
  }

  function activate() {
    active = true;
    ensureStyles();
    const root = overlay();
    root.hidden = false;
    load();
  }

  function close() {
    active = false;
    const root = document.getElementById("billing-automation-overlay");
    if (root) root.hidden = true;
  }

  document.addEventListener("click", async function (event) {
    if (event.target.closest("[data-billing-automation-nav]")) { event.preventDefault(); activate(); return; }
    if (event.target.closest("[data-ba-close]")) { close(); return; }
    if (event.target.closest("[data-ba-refresh]")) { load(); return; }
    const statusButton = event.target.closest("[data-ba-status]");
    if (statusButton) {
      statusButton.disabled = true;
      try {
        await api("/api/billing/automation/suspensions", {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ id: Number(statusButton.dataset.id), status: statusButton.dataset.baStatus })
        });
        await load();
      } catch (error) {
        window.alert(error.message || "No se pudo actualizar.");
        statusButton.disabled = false;
      }
    }
    const normalNav = event.target.closest(".sidebar .nav button:not([data-billing-automation-nav])");
    if (normalNav && active) close();
  }, true);

  function scan() {
    ensureStyles();
    ensureNav();
  }

  new MutationObserver(scan).observe(document.documentElement, { childList: true, subtree: true });
  document.addEventListener("DOMContentLoaded", scan);
  scan();
})();
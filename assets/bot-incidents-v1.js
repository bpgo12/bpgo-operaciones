(function () {
  "use strict";

  const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" })[char]);
  const statusLabel = (value) => ({ pending: "Pendiente", scheduled: "Agendada", resolved: "Resuelta", dismissed: "Descartada" })[value] || value;
  let active = false;

  function sidebarNav() {
    return document.querySelector(".sidebar .nav");
  }

  function ensureButton() {
    const nav = sidebarNav();
    if (!nav) return null;
    let btn = nav.querySelector("[data-bot-incidents-nav]");
    if (!btn) {
      btn = document.createElement("button");
      btn.type = "button";
      btn.dataset.botIncidentsNav = "true";
      btn.textContent = "Incidencias Bot";
      btn.addEventListener("click", (event) => {
        event.stopPropagation();
        activate();
      });
    }
    // Reubicar siempre justo después de "Turnos": la primera vez que corre el observer, el botón
    // de Turnos puede no existir todavía (React aún no terminó de pintar el menú), así que sin
    // esto el botón se quedaba pegado al final del menú donde cayó por defecto la primera vez.
    // El texto real del botón trae un ícono pegado (ej. "TTurnos"), así que una igualdad estricta
    // nunca matcheaba y el botón se quedaba pegado al final del menú (el fallback de más abajo).
    const turnos = [...nav.querySelectorAll("button")].find((item) => !item.dataset.botIncidentsNav && item.textContent.trim().toLowerCase().endsWith("turnos"));
    if (turnos && turnos.nextElementSibling !== btn) turnos.insertAdjacentElement("afterend", btn);
    else if (!turnos && !btn.isConnected) nav.appendChild(btn);
    return btn;
  }

  function overlayRoot() {
    let root = document.getElementById("bot-incidents-overlay");
    if (root) return root;
    const shell = document.querySelector(".app-shell");
    if (!shell) return null;
    root = document.createElement("div");
    root.id = "bot-incidents-overlay";
    root.hidden = true;
    root.innerHTML = '<div class="bot-incidents-page"><header class="bot-incidents-header"><div><p class="eyebrow">Bot autónomo</p><h1>Incidencias Bot</h1><p>Fallas técnicas y solicitudes de visita reportadas por clientes a través del bot de WhatsApp.</p></div><button type="button" class="btn secondary" data-bot-incidents-refresh>Actualizar</button></header><div class="automation-list" data-bot-incidents-list><div class="whatsapp-inbox-empty">Cargando…</div></div></div>';
    document.body.appendChild(root);
    root.querySelector("[data-bot-incidents-refresh]").addEventListener("click", load);
    return root;
  }

  function positionOverlay() {
    const root = document.getElementById("bot-incidents-overlay");
    const sidebar = document.querySelector(".sidebar");
    if (!root || !sidebar) return;
    root.style.left = sidebar.getBoundingClientRect().width + "px";
  }

  function setActiveNav(isActive) {
    const nav = sidebarNav();
    if (!nav) return;
    if (isActive) {
      [...nav.querySelectorAll("button")].forEach((item) => item.classList.remove("active"));
      const btn = nav.querySelector("[data-bot-incidents-nav]");
      if (btn) btn.classList.add("active");
    } else {
      const btn = nav.querySelector("[data-bot-incidents-nav]");
      if (btn) btn.classList.remove("active");
    }
  }

  function deactivate() {
    if (!active) return;
    active = false;
    setActiveNav(false);
    const root = document.getElementById("bot-incidents-overlay");
    if (root) root.hidden = true;
  }

  function activate() {
    active = true;
    setActiveNav(true);
    const root = overlayRoot();
    if (!root) return;
    positionOverlay();
    root.hidden = false;
    load();
  }

  // Un mismo "cliente sin internet" puede terminar como solicitud de visita (visit-requests) o
  // como descuento por corte (billing-requests) según cómo siga la conversación -- para el
  // equipo de Operaciones ambas son "tengo un cliente sin servicio", así que se muestran juntas.
  async function fetchList(endpoint, source) {
    const response = await fetch(endpoint, { cache: "no-store" });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || "No se pudo cargar las incidencias.");
    return (data.requests || []).map((item) => Object.assign({}, item, { _source: source }));
  }

  async function load() {
    const root = document.getElementById("bot-incidents-overlay");
    if (!root) return;
    const list = root.querySelector("[data-bot-incidents-list]");
    list.innerHTML = '<div class="whatsapp-test-status pending">Buscando incidencias…</div>';
    try {
      const [visits, billing] = await Promise.all([
        fetchList("/api/whatsapp/visit-requests", "visit"),
        fetchList("/api/whatsapp/billing-requests", "billing"),
      ]);
      const items = visits.concat(billing)
        .filter((item) => item.status !== "dismissed")
        .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
      updateBadge(items.filter((item) => item.status === "pending").length);
      if (!items.length) {
        list.innerHTML = '<div class="whatsapp-inbox-empty">No hay incidencias técnicas pendientes.</div>';
        return;
      }
      list.innerHTML = items.map((item) => {
        const identified = escapeHtml(item.reported_name || item.customer_name || item.customer_id || "Titular sin identificar");
        const extra = [];
        if (item.reported_name && item.customer_name && item.reported_name !== item.customer_name) extra.push("En sistema: " + escapeHtml(item.customer_name));
        if (item.preferred_date) extra.push("Prefiere: " + escapeHtml(item.preferred_date));
        if (item.days_without_service) extra.push(item.days_without_service + " día(s) sin servicio");
        if (item.reason) extra.push(escapeHtml(item.reason));
        const kindLabel = item._source === "billing" ? "Descuento por corte" : "Solicitud de visita";
        const resolveAction = item._source === "billing" ? "resolved" : "scheduled";
        const resolveLabel = item._source === "billing" ? "Marcar resuelta" : "Marcar agendada";
        return '<article class="automation-case technical_fault"><header><div><span class="automation-kind">' + kindLabel + '</span><strong>' + identified + '</strong><small>+' + escapeHtml(item.phone) + ' · ' + escapeHtml(new Date(item.created_at).toLocaleString("es-CL")) + '</small></div><span class="automation-state">' + escapeHtml(statusLabel(item.status)) + '</span></header>' + (extra.length ? '<p class="automation-details">' + extra.join(" · ") + '</p>' : '') + '<footer><button type="button" class="btn secondary small" data-bot-incidents-action="dismissed" data-source="' + item._source + '" data-id="' + escapeHtml(item.id) + '">Descartar</button><button type="button" class="btn small" data-bot-incidents-action="' + resolveAction + '" data-source="' + item._source + '" data-id="' + escapeHtml(item.id) + '">' + resolveLabel + '</button></footer></article>';
      }).join("");
    } catch (error) {
      list.innerHTML = '<div class="whatsapp-test-status error">' + escapeHtml(error.message || "Error al cargar incidencias") + '</div>';
    }
  }

  async function updateStatus(id, status, source) {
    const endpoint = source === "billing" ? "/api/whatsapp/billing-requests" : "/api/whatsapp/visit-requests";
    await fetch(endpoint, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: Number(id), status }),
    }).catch(() => null);
    load();
  }

  function updateBadge(pendingCount) {
    const nav = sidebarNav();
    const btn = nav && nav.querySelector("[data-bot-incidents-nav]");
    if (!btn) return;
    let badge = btn.querySelector("[data-bot-incidents-badge]");
    if (!pendingCount) {
      if (badge) badge.remove();
      return;
    }
    if (!badge) {
      badge = document.createElement("span");
      badge.dataset.botIncidentsBadge = "true";
      badge.className = "bot-incidents-badge";
      btn.appendChild(badge);
    }
    badge.textContent = String(pendingCount);
  }

  function ensureHomeCard() {
    const kpis = document.querySelector("#bpgo-os-overview .bpgo-os-kpis");
    if (!kpis || kpis.querySelector("[data-bot-incidents-kpi]")) return;
    const card = document.createElement("article");
    card.dataset.botIncidentsKpi = "true";
    card.className = "bot-incidents-kpi";
    card.innerHTML = "<span>Incidencias Bot</span><strong data-bot-incidents-kpi-count>—</strong><small>Reportadas por WhatsApp</small>";
    card.addEventListener("click", () => {
      ensureButton();
      activate();
    });
    kpis.appendChild(card);
    refreshHomeCount();
  }

  function refreshHomeCount() {
    const card = document.querySelector("[data-bot-incidents-kpi]");
    if (!card) return;
    fetch("/api/whatsapp/visit-requests", { cache: "no-store" })
      .then((response) => response.json())
      .then((data) => {
        const pending = (data.requests || []).filter((item) => item.status === "pending").length;
        updateBadge(pending);
        const countEl = card.querySelector("[data-bot-incidents-kpi-count]");
        if (countEl) countEl.textContent = String(pending);
      })
      .catch(() => null);
  }

  document.addEventListener("click", (event) => {
    const actionBtn = event.target.closest("[data-bot-incidents-action]");
    if (actionBtn) {
      updateStatus(actionBtn.dataset.id, actionBtn.dataset.botIncidentsAction);
      return;
    }
    const navBtn = event.target.closest(".sidebar .nav button");
    if (navBtn && !navBtn.dataset.botIncidentsNav) deactivate();
  }, true);

  window.addEventListener("resize", positionOverlay);

  function refresh() {
    ensureButton();
    ensureHomeCard();
    if (active) {
      const root = document.getElementById("bot-incidents-overlay");
      if (!root || root.hidden) activate();
      else positionOverlay();
    } else {
      refreshHomeCount();
    }
  }

  new MutationObserver(refresh).observe(document.documentElement, { childList: true, subtree: true });
  document.addEventListener("DOMContentLoaded", refresh);
  refresh();
})();

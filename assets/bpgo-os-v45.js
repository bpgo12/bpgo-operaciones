(function () {
  "use strict";

  const normalize = (value) => String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim().toLowerCase();
  const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" })[char]);
  const closed = new Set(["finalizado", "finalizada", "completado", "completada", "cerrado", "cerrada"]);
  let statePromise;

  function unwrap(payload) {
    let value = payload;
    for (let depth = 0; depth < 5; depth += 1) {
      if (typeof value === "string") { try { value = JSON.parse(value); continue; } catch { return {}; } }
      if (!value || typeof value !== "object") return {};
      if (Array.isArray(value.workOrders)) return value;
      if (value.data !== undefined) { value = value.data; continue; }
      if (value.state !== undefined) { value = value.state; continue; }
      break;
    }
    return value || {};
  }

  function loadState() {
    if (!statePromise) statePromise = fetch("/api/state", { cache: "no-store", credentials: "same-origin" })
      .then((response) => response.ok ? response.json() : Promise.reject(new Error(`HTTP ${response.status}`)))
      .then(unwrap);
    return statePromise;
  }

  function activeLabel() {
    const active = document.querySelector(".sidebar .nav button.active");
    return active ? active.textContent.trim() : "Inicio";
  }

  function enhanceBrand(sidebar) {
    const brand = sidebar.querySelector(".brand");
    if (!brand || brand.dataset.bpgoOs === "true") return;
    brand.dataset.bpgoOs = "true";
    const text = brand.querySelector("div:last-child");
    if (text) text.innerHTML = "<strong>BPGO OS</strong><span>Centro de operaciones</span>";
  }

  function groupNavigation(sidebar) {
    const nav = sidebar.querySelector(".nav");
    if (!nav || nav.dataset.bpgoOs === "true") return;
    nav.dataset.bpgoOs = "true";
    const groups = [
      { before: ["inicio"], label: "Resumen" },
      { before: ["dashboard ops", "planificacion", "mis actividades", "actividades", "calidad", "agenda", "turnos"], label: "Operación" },
      { before: ["clientes", "stock"], label: "Gestión" },
      { before: ["equipo", "ajustes"], label: "Administración" }
    ];
    const inserted = new Set();
    [...nav.querySelectorAll(":scope > button")].forEach((button) => {
      const label = normalize(button.textContent);
      const group = groups.find((item) => item.before.includes(label));
      if (!group || inserted.has(group.label)) return;
      const heading = document.createElement("span");
      heading.className = "bpgo-os-nav-group";
      heading.textContent = group.label;
      nav.insertBefore(heading, button);
      inserted.add(group.label);
    });
  }

  function goTo(label) {
    const wanted = normalize(label);
    const aliases = wanted === "actividades" ? new Set(["actividades", "mis actividades"]) : new Set([wanted]);
    const button = [...document.querySelectorAll(".sidebar .nav button")].find((item) => aliases.has(normalize(item.textContent)));
    if (button) button.click();
  }

  function hasNavigation(label) {
    const wanted = normalize(label);
    const aliases = wanted === "actividades" ? new Set(["actividades", "mis actividades"]) : new Set([wanted]);
    return [...document.querySelectorAll(".sidebar .nav button")].some((item) => aliases.has(normalize(item.textContent)));
  }

  function mountCommandBar(shell) {
    const content = shell.querySelector("main.content, main");
    if (!content || content.querySelector(":scope > #bpgo-os-commandbar")) return;
    const profile = shell.querySelector(".sidebar-footer .profile");
    const name = profile && profile.querySelector("strong") ? profile.querySelector("strong").textContent.trim() : "Usuario BPGO";
    const bar = document.createElement("header");
    bar.id = "bpgo-os-commandbar";
    bar.innerHTML = `<div><span>Centro de operaciones</span><strong data-bpgo-module>${escapeHtml(activeLabel())}</strong></div><div class="bpgo-os-command-actions"><span class="bpgo-os-online"><i></i>Sistema conectado</span><span class="bpgo-os-user">${escapeHtml(name)}</span><button type="button" data-bpgo-go="Actividades">Nueva actividad</button></div>`;
    content.insertBefore(bar, content.firstChild);
    bar.querySelector("[data-bpgo-go]").addEventListener("click", () => goTo("Actividades"));
  }

  function metrics(state) {
    const work = Array.isArray(state.workOrders) ? state.workOrders : [];
    const billing = Array.isArray(state.billingRecords) ? state.billingRecords : [];
    const customers = Array.isArray(state.customers) ? state.customers : [];
    const today = new Date().toISOString().slice(0, 10);
    const todayWork = work.filter((item) => String(item.plannedDate || item.dueDate || "").slice(0, 10) === today);
    const finishedToday = todayWork.filter((item) => closed.has(normalize(item.status))).length;
    const open = work.filter((item) => !closed.has(normalize(item.status)) && normalize(item.status) !== "cancelada").length;
    const overdue = work.filter((item) => !closed.has(normalize(item.status)) && item.dueDate && String(item.dueDate).slice(0, 10) < today).length;
    const pendingBilling = billing.filter((item) => !["pagado", "convenio"].includes(normalize(item.status))).length;
    return { today: todayWork.length, finishedToday, open, overdue, pendingBilling, customers: customers.length };
  }

  function overviewMarkup(values, viewerName) {
    const alertCount = values.overdue + values.pendingBilling;
    return `<section id="bpgo-os-overview">
      <div class="bpgo-os-welcome"><div><span>BPGO OS · Información en tiempo real</span><h1>Hola, ${escapeHtml(viewerName.split(" ")[0])}</h1><p>Este es el estado general de la operación. Los módulos originales continúan disponibles y conectados.</p></div><div class="bpgo-os-date">${escapeHtml(new Intl.DateTimeFormat("es-CL", { weekday: "long", day: "numeric", month: "long" }).format(new Date()))}</div></div>
      ${alertCount ? `<button type="button" class="bpgo-os-alert" data-bpgo-alert><strong>${alertCount} asuntos requieren atención</strong><span>${values.overdue} actividades vencidas · ${values.pendingBilling} registros de cobranza pendientes</span><b>Revisar operación →</b></button>` : '<div class="bpgo-os-all-good"><strong>Operación al día</strong><span>No se detectaron actividades vencidas ni cobros pendientes.</span></div>'}
      <div class="bpgo-os-kpis">
        <article><span>Actividades de hoy</span><strong>${values.today}</strong><small>${values.finishedToday} finalizadas</small></article>
        <article><span>Operación abierta</span><strong>${values.open}</strong><small>${values.overdue} fuera de plazo</small></article>
        <article><span>Cobranza pendiente</span><strong>${values.pendingBilling}</strong><small>Casos que requieren gestión</small></article>
        <article><span>Clientes registrados</span><strong>${values.customers}</strong><small>Base operativa central</small></article>
      </div>
      <div class="bpgo-os-shortcuts"><button type="button" data-bpgo-go="Dashboard Ops"><b>Operaciones</b><span>Productividad, puntos y cierres</span></button><button type="button" data-bpgo-go="Actividades"><b>Actividades</b><span>Crear, buscar y gestionar trabajos</span></button><button type="button" data-bpgo-go="Clientes"><b>Clientes</b><span>Ficha e historial centralizado</span></button><button type="button" data-bpgo-go="Stock"><b>Inventario</b><span>Equipos, materiales y series</span></button></div>
    </section>`;
  }

  async function mountOverview(shell) {
    const active = normalize(activeLabel());
    const content = shell.querySelector("main.content, main");
    if (!content) return;
    if (active !== "inicio") { content.querySelectorAll("#bpgo-os-overview").forEach((item) => item.remove()); return; }
    if (content.querySelector("#bpgo-os-overview, #bpgo-os-overview-loading")) return;
    const profile = shell.querySelector(".sidebar-footer .profile strong");
    const viewerName = profile ? profile.textContent.trim() : "equipo BPGO";
    const mount = document.createElement("div");
    mount.id = "bpgo-os-overview-loading";
    mount.innerHTML = '<section class="bpgo-os-loading">Preparando resumen operativo…</section>';
    const command = content.querySelector("#bpgo-os-commandbar");
    command.insertAdjacentElement("afterend", mount);
    try {
      const state = await loadState();
      mount.outerHTML = overviewMarkup(metrics(state), viewerName);
      const overview = content.querySelector("#bpgo-os-overview");
      overview.querySelectorAll("[data-bpgo-go]").forEach((button) => {
        if (!hasNavigation(button.dataset.bpgoGo)) { button.remove(); return; }
        button.addEventListener("click", () => goTo(button.dataset.bpgoGo));
      });
      const alert = overview.querySelector("[data-bpgo-alert]");
      if (alert) alert.addEventListener("click", () => goTo("Dashboard Ops"));
    } catch (error) {
      mount.innerHTML = `<section class="bpgo-os-loading">No se pudo preparar el resumen: ${escapeHtml(error.message)}</section>`;
    }
  }

  function refresh() {
    const shell = document.querySelector(".app-shell");
    if (!shell) return;
    document.body.classList.add("bpgo-os-active");
    const sidebar = shell.querySelector(".sidebar");
    if (sidebar) { enhanceBrand(sidebar); groupNavigation(sidebar); }
    mountCommandBar(shell);
    const module = shell.querySelector("[data-bpgo-module]");
    if (module && module.textContent !== activeLabel()) module.textContent = activeLabel();
    mountOverview(shell);
  }

  document.addEventListener("click", (event) => {
    if (!event.target.closest(".sidebar .nav button")) return;
    window.setTimeout(refresh, 30);
  });
  window.addEventListener("focus", () => { statePromise = null; refresh(); });
  new MutationObserver(refresh).observe(document.documentElement, { childList: true, subtree: true });
  window.addEventListener("DOMContentLoaded", refresh);
})();

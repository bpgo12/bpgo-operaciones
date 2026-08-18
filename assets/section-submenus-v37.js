(function () {
  "use strict";
  var timer = 0;
  var menus = {
    "inicio": [["top", "Resumen principal", "⌂"], ["search", "Buscar actividad", "⌕"], ["today", "Trabajos de hoy", "◷"]],
    "dashboard ops": [["points", "Indicadores y puntos", "▦"], ["tech-summary", "Resumen por técnico", "▥"], ["closed", "Actividades finalizadas", "☷"], ["rules", "Reglas de puntaje", "!"]],
    "planificacion": [["new-request", "Nueva solicitud", "+"], ["search", "Buscar", "⌕"], ["pending-plan", "Por planificar", "◷"], ["programmed", "Programadas", "✓"]],
    "actividades": [["new", "Nueva actividad", "+"], ["search", "Buscar", "⌕"], ["summary", "Resumen y puntos", "▦"], ["list", "Lista de trabajos", "☷"]],
    "mis actividades": [["new", "Nueva actividad", "+"], ["search", "Buscar", "⌕"], ["list", "Lista de trabajos", "☷"]],
    "calidad": [["quality-summary", "Resumen de calidad", "▦"], ["review", "Pendientes de revisión", "◷"], ["evidence", "Evidencias", "◉"]],
    "agenda": [["new", "Nueva actividad", "+"], ["search", "Buscar", "⌕"], ["pending-agenda", "Por planificar", "◷"], ["calendar", "Calendario", "▦"]],
    "turnos": [["technician", "Seleccionar técnico", "⌄"], ["suggest", "Sugerir turnos", "✦"], ["shift-calendar", "Calendario", "▦"], ["save-shifts", "Guardar turnos", "✓"]],
    "clientes": [["customer-summary", "Resumen de clientes", "▦"], ["search", "Buscar cliente", "⌕"], ["new-client", "Nuevo cliente", "+"], ["customer-list", "Listado", "☷"]],
    "stock": [["stock-summary", "Resumen de stock", "▦"], ["stock-list", "Inventario", "☷"], ["stock-moves", "Movimientos", "⇄"]],
    "equipo": [["team-summary", "Resumen del equipo", "▦"], ["add-user", "Agregar usuario", "+"], ["users", "Usuarios y permisos", "☷"], ["audit", "Auditoría", "◉"]],
    "ajustes": [["infrastructure", "Infraestructura", "▦"], ["users", "Usuarios", "☷"], ["export", "Exportar datos", "⇩"], ["save-users", "Guardar usuarios", "✓"]]
  };

  function normalize(value) { return String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim().toLowerCase(); }
  function visible(element) { return !!(element && element.getClientRects().length && getComputedStyle(element).display !== "none"); }
  function activeMenu() {
    return Array.from(document.querySelectorAll(".sidebar .nav > button, .sidebar .nav > .bpgo-shifts-nav")).find(function (button) {
      return button.classList.contains("active") && menus[normalize(button.textContent)];
    });
  }
  function findText(selector, texts) {
    var wanted = (Array.isArray(texts) ? texts : [texts]).map(normalize);
    return Array.from(document.querySelectorAll(selector)).find(function (element) {
      var content = normalize(element.textContent);
      return visible(element) && wanted.some(function (text) { return content.includes(text); });
    });
  }
  function notify(message) {
    var old = document.querySelector(".section-nav-toast");
    if (old) old.remove();
    var toast = document.createElement("div");
    toast.className = "section-nav-toast";
    toast.textContent = message;
    document.body.appendChild(toast);
    requestAnimationFrame(function () { toast.classList.add("show"); });
    window.setTimeout(function () { toast.remove(); }, 2600);
  }
  function reveal(element, missing) {
    if (!visible(element)) { notify(missing || "Esta sección no tiene información disponible por ahora."); return false; }
    element.scrollIntoView({ behavior: "smooth", block: "start" });
    element.classList.add("section-nav-highlight");
    window.setTimeout(function () { element.classList.remove("section-nav-highlight"); }, 1600);
    return true;
  }
  function clickText(texts, missing) {
    var element = findText("button", texts);
    if (element) { element.click(); return true; }
    notify(missing || "Esta acción no está disponible en esta vista.");
    return false;
  }
  function focusSearch() {
    var section = normalize((activeMenu() || {}).textContent);
    var input = section === "actividades" || section === "agenda" ? document.querySelector(".activity-finder input") : null;
    input = input || document.querySelector(".global-search input") || document.querySelector('input[type="search"]');
    if (!input) { notify("No hay un buscador disponible en esta vista."); return; }
    reveal(input.closest(".activity-finder, .global-search, .planning-toolbar") || input);
    window.setTimeout(function () { input.focus(); input.select(); }, 240);
  }
  function heading(texts) {
    var item = findText("h1, h2, h3, strong", texts);
    return item && (item.closest("section, article, .panel, .topbar, .planning-column") || item);
  }
  function firstVisible(selectors) {
    var result = null;
    selectors.some(function (selector) { result = Array.from(document.querySelectorAll(selector)).find(visible); return !!result; });
    return result;
  }

  function run(action) {
    var target = null;
    if (action === "top") { window.scrollTo({ top: 0, behavior: "smooth" }); return; }
    if (action === "search") { focusSearch(); return; }
    if (action === "new") { clickText(["Nuevo trabajo", "Nueva actividad"], "No se encontró el botón para crear una actividad."); return; }
    if (action === "new-request") { clickText(["Registrar solicitud", "Nueva solicitud"], "No se encontró el formulario de nueva solicitud."); return; }
    if (action === "new-client") { clickText(["Nuevo cliente", "Agregar cliente"]); return; }
    if (action === "add-user") { clickText("Agregar usuario"); return; }
    if (action === "suggest") { clickText("Sugerir turnos"); return; }
    if (action === "save-shifts") { clickText(["Guardar calendario", "Guardar turnos"]); return; }
    if (action === "export") { clickText("Exportar datos"); return; }
    if (action === "save-users") { clickText("Guardar usuarios"); return; }

    if (action === "points" || action === "summary") target = document.querySelector("#bpgo-points-dashboard .bpgo-point-grid, #bpgo-points-dashboard");
    else if (action === "tech-summary") target = document.querySelector("#bpgo-points-dashboard .bpgo-tech-grid");
    else if (action === "closed") target = document.querySelector("#bpgo-points-dashboard .bpgo-analysis-table");
    else if (action === "rules") target = document.querySelector("#bpgo-points-dashboard .bpgo-method-panel");
    else if (action === "technician") target = document.querySelector(".shift-technician");
    else if (action === "list") target = heading("Trabajos BPGO");
    else if (action === "today") target = heading(["Trabajos de hoy", "Hoy"]);
    else if (action === "pending-plan") target = heading(["Por planificar", "Sin planificar"]);
    else if (action === "programmed") target = heading(["Programadas", "Planificadas"]);
    else if (action === "quality-summary") target = firstVisible([".review-grid", ".stats", ".topbar"]);
    else if (action === "review") target = heading(["Pendientes de revisión", "Pendiente revisión", "Pendientes"]);
    else if (action === "evidence") target = heading(["Evidencias", "Evidencia fotográfica"]);
    else if (action === "pending-agenda") target = heading(["Ordenes por planificar", "Órdenes por planificar"]);
    else if (action === "calendar") target = document.querySelector(".operations-calendar");
    else if (action === "shift-calendar") target = document.querySelector(".shift-calendar-panel");
    else if (action === "customer-summary") target = firstVisible([".stats", ".module-grid", ".topbar"]);
    else if (action === "customer-list") target = firstVisible([".customer-grid", ".table-wrap", "table"]);
    else if (action === "stock-summary") target = firstVisible([".stock-summary", ".stats", ".module-grid", ".topbar"]);
    else if (action === "stock-list") target = heading(["Inventario", "Stock disponible", "Materiales"]);
    else if (action === "stock-moves") target = heading(["Movimientos", "Historial", "Entradas y salidas"]);
    else if (action === "team-summary") target = firstVisible([".stats", ".topbar"]);
    else if (action === "users") target = heading(["Usuarios y permisos", "Usuarios"]);
    else if (action === "audit") target = heading(["Auditoría", "Registro de actividad"]);
    else if (action === "infrastructure") target = heading("Infraestructura");
    reveal(target, "No hay registros para mostrar en esta opción.");
  }

  function submenuMarkup(key) {
    return '<div class="section-submenu" data-section-menu="' + key + '">' + menus[key].map(function (item) {
      return '<a href="#" role="button" data-section-action="' + item[0] + '"><b>' + item[2] + '</b><span>' + item[1] + "</span></a>";
    }).join("") + "</div>";
  }
  function install() {
    var active = activeMenu();
    var key = active && normalize(active.textContent);
    document.querySelectorAll(".section-submenu").forEach(function (submenu) {
      if (!active || submenu.dataset.sectionMenu !== key || submenu.previousElementSibling !== active) submenu.remove();
    });
    if (active && !document.querySelector('.section-submenu[data-section-menu="' + key + '"]')) active.insertAdjacentHTML("afterend", submenuMarkup(key));
  }
  document.addEventListener("click", function (event) {
    var action = event.target.closest("[data-section-action]");
    if (!action) return;
    event.preventDefault();
    document.querySelectorAll(".section-submenu a").forEach(function (item) { item.classList.remove("selected"); });
    action.classList.add("selected");
    run(action.dataset.sectionAction);
  });
  function scan() { clearTimeout(timer); timer = window.setTimeout(install, 70); }
  new MutationObserver(scan).observe(document.documentElement, { childList: true, subtree: true });
  document.addEventListener("DOMContentLoaded", install);
  install();
})();

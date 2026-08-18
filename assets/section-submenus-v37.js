(function () {
  "use strict";

  var timer = 0;
  var menus = {
    "inicio": [["top", "Resumen principal", "⌂"], ["search", "Buscar actividad", "⌕"], ["today", "Trabajos de hoy", "◷"]],
    "dashboard ops": [["top", "Indicadores", "▦"], ["charts", "Gráficos operativos", "⌁"], ["productivity", "Productividad", "▥"], ["alerts", "Alertas", "!"]],
    "planificacion": [["new-request", "Nueva solicitud", "+"], ["search", "Buscar", "⌕"], ["pending-plan", "Por planificar", "◷"], ["programmed", "Programadas", "✓"]],
    "actividades": [["new", "Nueva actividad", "+"], ["search", "Buscar", "⌕"], ["summary", "Resumen y puntos", "▦"], ["list", "Lista de trabajos", "☷"]],
    "mis actividades": [["new", "Nueva actividad", "+"], ["search", "Buscar", "⌕"], ["list", "Lista de trabajos", "☷"]],
    "calidad": [["top", "Resumen de calidad", "▦"], ["review", "Pendientes de revisión", "◷"], ["evidence", "Evidencias", "◉"]],
    "agenda": [["new", "Nueva actividad", "+"], ["search", "Buscar", "⌕"], ["pending-agenda", "Por planificar", "◷"], ["calendar", "Calendario", "▦"]],
    "turnos": [["technician", "Seleccionar técnico", "⌄"], ["suggest", "Sugerir turnos", "✦"], ["shift-calendar", "Calendario", "▦"], ["save-shifts", "Guardar turnos", "✓"]],
    "clientes": [["top", "Resumen de clientes", "▦"], ["search", "Buscar cliente", "⌕"], ["new-client", "Nuevo cliente", "+"], ["customer-list", "Listado", "☷"]],
    "stock": [["top", "Resumen de stock", "▦"], ["stock-list", "Inventario", "☷"], ["stock-moves", "Movimientos", "⇄"]],
    "equipo": [["top", "Resumen del equipo", "▦"], ["add-user", "Agregar usuario", "+"], ["users", "Usuarios y permisos", "☷"], ["audit", "Auditoría", "◉"]],
    "ajustes": [["infrastructure", "Infraestructura", "▦"], ["users", "Usuarios", "☷"], ["export", "Exportar datos", "⇩"], ["save-users", "Guardar usuarios", "✓"]]
  };

  function normalize(value) {
    return String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim().toLowerCase();
  }

  function activeMenu() {
    return Array.from(document.querySelectorAll(".sidebar .nav > button, .sidebar .nav > .bpgo-shifts-nav")).find(function (button) {
      return button.classList.contains("active") && menus[normalize(button.textContent)];
    });
  }

  function findText(selector, texts) {
    var wanted = Array.isArray(texts) ? texts : [texts];
    return Array.from(document.querySelectorAll(selector)).find(function (element) {
      var content = normalize(element.textContent);
      return wanted.some(function (text) { return content.includes(normalize(text)); });
    });
  }

  function clickText(texts) {
    var element = findText("button", texts);
    if (element) element.click();
    return element;
  }

  function scroll(element) {
    if (element) element.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function focusSearch() {
    var input = document.querySelector(".activity-finder input") || document.querySelector(".global-search input") || document.querySelector('input[type="search"]');
    scroll(input && (input.closest(".activity-finder, .global-search") || input));
    window.setTimeout(function () { if (input) input.focus(); }, 220);
  }

  function heading(texts) {
    var item = findText("h1, h2, h3", texts);
    return item && (item.closest("section, .topbar") || item);
  }

  function run(action) {
    var target = null;
    if (action === "top") { window.scrollTo({ top: 0, behavior: "smooth" }); return; }
    if (action === "search") { focusSearch(); return; }
    if (action === "new") { clickText(["Nuevo trabajo", "Nueva actividad"]); return; }
    if (action === "new-request") { clickText(["Registrar solicitud", "Nueva solicitud"]); return; }
    if (action === "new-client") { clickText(["Nuevo cliente", "Agregar cliente"]); return; }
    if (action === "add-user") { clickText("Agregar usuario"); return; }
    if (action === "suggest") { clickText("Sugerir turnos"); return; }
    if (action === "save-shifts") { clickText(["Guardar calendario", "Guardar turnos"]); return; }
    if (action === "export") { clickText("Exportar datos"); return; }
    if (action === "save-users") { clickText("Guardar usuarios"); return; }
    if (action === "technician") target = document.querySelector(".shift-technician");
    else if (action === "summary") target = document.querySelector("#bpgo-points-dashboard");
    else if (action === "list") target = heading("Trabajos BPGO");
    else if (action === "today") target = heading(["Trabajos de hoy", "Hoy"]);
    else if (action === "charts") target = heading(["Avance operativo", "Distribución por estado"]);
    else if (action === "productivity") target = heading("Productividad");
    else if (action === "alerts") target = heading(["Atención del supervisor", "Alertas"]);
    else if (action === "pending-plan") target = heading("Por planificar");
    else if (action === "programmed") target = heading("Programadas");
    else if (action === "review") target = heading(["Pendientes", "Revisión"]);
    else if (action === "evidence") target = heading("Evidencias");
    else if (action === "pending-agenda") target = heading("Ordenes por planificar");
    else if (action === "calendar") target = document.querySelector(".operations-calendar");
    else if (action === "shift-calendar") target = document.querySelector(".shift-calendar-panel");
    else if (action === "customer-list") target = document.querySelector(".customer-grid, table");
    else if (action === "stock-list") target = heading(["Inventario", "Stock"]);
    else if (action === "stock-moves") target = heading(["Movimientos", "Historial"]);
    else if (action === "users") target = heading("Usuarios y permisos");
    else if (action === "audit") target = heading(["Auditoría", "Registro de actividad"]);
    else if (action === "infrastructure") target = heading("Infraestructura");
    scroll(target);
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
    run(action.dataset.sectionAction);
  });

  function scan() { clearTimeout(timer); timer = window.setTimeout(install, 70); }
  new MutationObserver(scan).observe(document.documentElement, { childList: true, subtree: true });
  document.addEventListener("DOMContentLoaded", install);
  install();
})();

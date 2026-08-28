(function () {
  "use strict";

  var MONTH_NAMES = ["Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio", "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre"];
  var WEEKDAY_LABELS = ["L", "M", "M", "J", "V", "S", "D"];

  var state = null;
  var loading = null;
  var timer = 0;
  var viewMonth = null; // {year, month(0-based)}
  var selectedDate = null; // "YYYY-MM-DD"

  function normalize(value) {
    return String(value || "").normalize("NFD").replace(/[̀-ͯ]/g, "").trim().toLowerCase();
  }

  function escapeHtml(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, function (char) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[char];
    });
  }

  function pad2(value) { return String(value).padStart(2, "0"); }

  function toDateKey(value) {
    if (!value) return "";
    var text = String(value).trim();
    var match = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (match) return match[1] + "-" + match[2] + "-" + match[3];
    var parsed = new Date(text);
    if (isNaN(parsed.getTime())) return "";
    return parsed.getFullYear() + "-" + pad2(parsed.getMonth() + 1) + "-" + pad2(parsed.getDate());
  }

  function todayKey() {
    var now = new Date();
    return now.getFullYear() + "-" + pad2(now.getMonth() + 1) + "-" + pad2(now.getDate());
  }

  function isMobileViewport() {
    return window.innerWidth <= 900;
  }

  function loadState(force) {
    if (loading) return loading;
    if (state && !force) return Promise.resolve(state);
    loading = fetch("/api/state?mobile-agenda-calendar=" + Date.now(), { cache: "no-store" })
      .then(function (response) { if (!response.ok) throw new Error("state"); return response.json(); })
      .then(function (result) { state = result.data || {}; return state; })
      .finally(function () { loading = null; });
    return loading;
  }

  function activitiesByDate() {
    var map = {};
    var orders = state && Array.isArray(state.workOrders) ? state.workOrders : [];
    orders.forEach(function (work) {
      var key = toDateKey(work.plannedDate || work.dueDate);
      if (!key) return;
      if (!map[key]) map[key] = [];
      map[key].push(work);
    });
    return map;
  }

  function technicianName(id) {
    var users = state && Array.isArray(state.users) ? state.users : [];
    var user = users.find(function (item) { return item.id === id; });
    return user ? user.name : "";
  }

  function activityLabel(work) {
    var assigned = Array.isArray(work.assignedToIds) ? work.assignedToIds.map(technicianName).filter(Boolean) : [];
    return {
      code: work.code || "",
      client: work.client || "Sin cliente",
      type: work.type || work.title || "Actividad",
      status: work.status || "Sin estado",
      tech: assigned.join(", ")
    };
  }

  function planificacionActive() {
    return Array.from(document.querySelectorAll(".sidebar .nav button, .mobile-nav button")).find(function (button) {
      return button.classList.contains("active") && normalize(button.textContent) === "planificacion";
    });
  }

  function setInputValue(input, value) {
    var setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }

  function openActivity(code) {
    if (!code) return;
    var activities = Array.from(document.querySelectorAll(".sidebar .nav button, .mobile-nav button")).find(function (button) {
      var text = normalize(button.textContent);
      return text === "actividades" || text === "mis actividades";
    });
    if (activities) activities.click();
    window.setTimeout(function () {
      var input = document.querySelector(".global-search input");
      if (!input) return;
      setInputValue(input, code);
      window.setTimeout(function () {
        var result = Array.from(document.querySelectorAll(".search-results button")).find(function (button) { return button.textContent.includes(code); });
        if (result) result.click();
        // Limpia la búsqueda para que no quede el código pegado al volver a esta vista.
        window.setTimeout(function () { setInputValue(input, ""); }, 200);
      }, 150);
    }, 100);
  }

  function buildGrid(map) {
    var year = viewMonth.year, month = viewMonth.month;
    var firstOfMonth = new Date(year, month, 1);
    var startOffset = (firstOfMonth.getDay() + 6) % 7; // Monday-first
    var daysInMonth = new Date(year, month + 1, 0).getDate();
    var daysInPrevMonth = new Date(year, month, 0).getDate();
    var cells = [];
    for (var i = 0; i < startOffset; i++) {
      var prevDay = daysInPrevMonth - startOffset + i + 1;
      cells.push({ day: prevDay, outside: true, key: "" });
    }
    for (var d = 1; d <= daysInMonth; d++) {
      cells.push({ day: d, outside: false, key: year + "-" + pad2(month + 1) + "-" + pad2(d) });
    }
    while (cells.length % 7 !== 0 || cells.length < 42) {
      var nextDay = cells.length - (startOffset + daysInMonth) + 1;
      cells.push({ day: nextDay, outside: true, key: "" });
      if (cells.length >= 42) break;
    }
    var today = todayKey();
    return cells.map(function (cell) {
      var count = cell.key && map[cell.key] ? map[cell.key].length : 0;
      var classes = ["mac-day"];
      if (cell.outside) classes.push("outside");
      if (cell.key === today) classes.push("today");
      if (cell.key && cell.key === selectedDate) classes.push("selected");
      if (count > 0) classes.push("has-activities");
      return '<button type="button" class="' + classes.join(" ") + '" data-mac-date="' + cell.key + '">' +
        '<span class="mac-day-number">' + cell.day + '</span>' +
        (count > 0 ? '<span class="mac-day-dot"></span>' : '') +
        '</button>';
    }).join("");
  }

  function buildAgendaList(map) {
    var key = selectedDate;
    var items = (key && map[key]) || [];
    if (!key) return '<p class="mac-empty">Selecciona un día para ver sus actividades.</p>';
    var dateObj = new Date(key + "T00:00:00");
    var dateLabel = dateObj.toLocaleDateString("es-CL", { weekday: "long", day: "numeric", month: "long" });
    var heading = '<h4 class="mac-agenda-heading">' + escapeHtml(dateLabel.charAt(0).toUpperCase() + dateLabel.slice(1)) + '</h4>';
    if (!items.length) return heading + '<p class="mac-empty">Sin actividades programadas este día.</p>';
    var rows = items.map(function (work) {
      var info = activityLabel(work);
      return '<button type="button" class="mac-activity" data-mac-open="' + escapeHtml(info.code) + '">' +
        '<span class="mac-activity-top"><strong>' + escapeHtml(info.client) + '</strong><em>' + escapeHtml(info.status) + '</em></span>' +
        '<span class="mac-activity-bottom">' + escapeHtml(info.type) + (info.tech ? " · " + escapeHtml(info.tech) : "") + (info.code ? " · " + escapeHtml(info.code) : "") + '</span>' +
        '</button>';
    }).join("");
    return heading + '<div class="mac-agenda-list">' + rows + '</div>';
  }

  function render() {
    var panel = document.querySelector(".mobile-agenda-calendar");
    if (!panel || !state) return;
    var map = activitiesByDate();
    panel.querySelector(".mac-month-label").textContent = MONTH_NAMES[viewMonth.month] + " " + viewMonth.year;
    panel.querySelector(".mac-grid").innerHTML = buildGrid(map);
    panel.querySelector(".mac-agenda").innerHTML = buildAgendaList(map);
  }

  function install() {
    var active = planificacionActive();
    var existing = document.querySelector(".mobile-agenda-calendar");
    if (!active || !isMobileViewport()) {
      if (existing) existing.remove();
      return;
    }
    if (existing) return;
    var content = document.querySelector("main.content");
    var anchor = content && (content.querySelector(".breadcrumbs") || content.querySelector(".topbar"));
    if (!anchor) return;
    // Cada vez que se vuelve a entrar a Planificación se reinicia al mes y día
    // actuales, para no dejar al usuario mirando un mes en el que quedó
    // navegando la última vez que visitó esta sección.
    var now = new Date();
    viewMonth = { year: now.getFullYear(), month: now.getMonth() };
    selectedDate = todayKey();
    var panel = document.createElement("section");
    panel.className = "mobile-agenda-calendar";
    panel.innerHTML =
      '<div class="mac-header">' +
      '<button type="button" class="mac-nav" data-mac-nav="-1" aria-label="Mes anterior">‹</button>' +
      '<span class="mac-month-label">Cargando…</span>' +
      '<button type="button" class="mac-nav" data-mac-nav="1" aria-label="Mes siguiente">›</button>' +
      '<button type="button" class="mac-today" data-mac-today>Hoy</button>' +
      '</div>' +
      '<div class="mac-weekdays">' + WEEKDAY_LABELS.map(function (label) { return '<span>' + label + '</span>'; }).join("") + '</div>' +
      '<div class="mac-grid"></div>' +
      '<div class="mac-agenda"></div>';
    anchor.insertAdjacentElement("afterend", panel);
    // Refresca datos al (re)entrar a esta vista, para no mostrar información
    // que quedó obsoleta desde la última visita.
    loadState(true).then(render).catch(function () {});
  }

  document.addEventListener("click", function (event) {
    var navButton = event.target.closest("[data-mac-nav]");
    if (navButton) {
      var delta = Number(navButton.dataset.macNav);
      var next = new Date(viewMonth.year, viewMonth.month + delta, 1);
      viewMonth = { year: next.getFullYear(), month: next.getMonth() };
      render();
      return;
    }
    if (event.target.closest("[data-mac-today]")) {
      var now = new Date();
      viewMonth = { year: now.getFullYear(), month: now.getMonth() };
      selectedDate = todayKey();
      render();
      return;
    }
    var dayButton = event.target.closest("[data-mac-date]");
    if (dayButton && dayButton.dataset.macDate) {
      selectedDate = dayButton.dataset.macDate;
      render();
      return;
    }
    var openButton = event.target.closest("[data-mac-open]");
    if (openButton) openActivity(openButton.dataset.macOpen);
  });

  function scan() {
    clearTimeout(timer);
    timer = window.setTimeout(function () {
      if (state) install();
      else loadState(false).then(install).catch(function () {});
    }, 90);
  }

  window.addEventListener("resize", function () {
    clearTimeout(timer);
    timer = window.setTimeout(install, 120);
  });
  new MutationObserver(scan).observe(document.documentElement, { childList: true, subtree: true });
  document.addEventListener("DOMContentLoaded", scan);
  scan();
})();

(function () {
  "use strict";

  var state = null;
  var loading = null;
  var timer = 0;

  function normalize(value) {
    return String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim().toLowerCase();
  }

  function escapeHtml(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, function (char) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[char];
    });
  }

  function loadState(force) {
    if (loading) return loading;
    if (state && !force) return Promise.resolve(state);
    loading = fetch("/api/state?agenda-integrada=" + Date.now(), { cache: "no-store" })
      .then(function (response) { if (!response.ok) throw new Error("state"); return response.json(); })
      .then(function (result) { state = result.data || {}; return state; })
      .finally(function () { loading = null; });
    return loading;
  }

  function activeTechnicians() {
    return (state && Array.isArray(state.users) ? state.users : []).filter(function (user) {
      return user.active !== false && user.role === "technician";
    });
  }

  function dateForColumn(column, monthValue) {
    if (!monthValue || column.classList.contains("outside-month")) return "";
    var heading = column.querySelector(".day-head strong");
    var match = heading && heading.textContent.match(/(\d{1,2})\s*$/);
    return match ? monthValue + "-" + String(Number(match[1])).padStart(2, "0") : "";
  }

  function decorateAgenda() {
    var title = Array.from(document.querySelectorAll("h1")).find(function (item) {
      return normalize(item.textContent) === "calendario de trabajos";
    });
    if (!title || !state) return;
    var calendar = document.querySelector(".operations-calendar");
    var monthSelect = calendar && calendar.querySelector(".calendar-month-select select");
    if (!calendar || !monthSelect) return;
    var technicians = activeTechnicians();
    var shifts = Array.isArray(state.technicianShifts) ? state.technicianShifts : [];

    calendar.querySelectorAll(".day-column").forEach(function (column) {
      var date = dateForColumn(column, monthSelect.value);
      var head = column.querySelector(".day-head");
      if (!date || !head) return;
      var dayShifts = technicians.map(function (user) {
        var shift = shifts.find(function (item) { return item.userId === user.id && item.date === date; });
        return { user: user, status: shift ? shift.status : "Sin turno definido" };
      });
      var workSignature = Array.from(column.querySelectorAll(".day-work")).map(function (work) { return normalize(work.textContent.replace(/^⚠[^\n]*/, "")); }).join("|");
      var signature = date + "|" + dayShifts.map(function (item) { return item.user.id + ":" + item.status; }).join("|") + "|" + workSignature;
      var old = column.querySelector(".agenda-roster-status");
      if (old && old.dataset.signature === signature) return;
      if (old) old.remove();
      column.querySelectorAll(".shift-conflict-label").forEach(function (label) { label.remove(); });
      column.querySelectorAll(".day-work.shift-conflict").forEach(function (work) { work.classList.remove("shift-conflict"); });
      var roster = document.createElement("div");
      roster.className = "agenda-roster-status";
      roster.dataset.signature = signature;
      roster.innerHTML = dayShifts.map(function (item) {
        var blocked = item.status === "Descanso" || item.status === "Feriado";
        return '<span class="' + (blocked ? "off" : item.status === "Turno" ? "on" : "unset") + '" title="' + escapeHtml(item.user.name + ": " + item.status) + '">' + escapeHtml(item.user.name.split(" ")[0]) + ': ' + escapeHtml(item.status) + "</span>";
      }).join("");
      head.insertAdjacentElement("afterend", roster);

      dayShifts.filter(function (item) { return item.status === "Descanso" || item.status === "Feriado"; }).forEach(function (item) {
        var person = normalize(item.user.name);
        column.querySelectorAll(".day-work").forEach(function (work) {
          if (!normalize(work.textContent).includes(person)) return;
          work.classList.add("shift-conflict");
          if (!work.querySelector(".shift-conflict-label")) {
            work.insertAdjacentHTML("afterbegin", '<b class="shift-conflict-label">⚠ ' + escapeHtml(item.user.name) + " está con " + escapeHtml(item.status.toLowerCase()) + "</b>");
          }
        });
      });
    });
  }

  function searchText(work) {
    var customers = Array.isArray(state.customers) ? state.customers : [];
    var users = Array.isArray(state.users) ? state.users : [];
    var customer = customers.find(function (item) { return item.id === work.customerId || normalize(item.name) === normalize(work.client); });
    var assigned = (work.assignedToIds || []).map(function (id) {
      var user = users.find(function (item) { return item.id === id; });
      return user ? user.name : "";
    });
    return normalize([work.code, work.client, work.title, work.type, work.status, work.location, work.sector, work.description, customer && customer.phone, customer && customer.whatsapp, customer && customer.rut, customer && customer.address, assigned.join(" ")].join(" "));
  }

  function openWork(code) {
    var activities = Array.from(document.querySelectorAll(".sidebar .nav button, .mobile-nav button")).find(function (button) {
      var text = normalize(button.textContent);
      return text === "actividades" || text === "mis actividades";
    });
    if (activities) activities.click();
    window.setTimeout(function () {
      var input = document.querySelector(".global-search input");
      if (!input) return;
      var setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
      setter.call(input, code);
      input.dispatchEvent(new Event("input", { bubbles: true }));
      window.setTimeout(function () {
        var result = Array.from(document.querySelectorAll(".search-results button")).find(function (button) { return button.textContent.includes(code); });
        if (result) result.click();
      }, 120);
    }, 100);
  }

  function installSearch() {
    var heading = Array.from(document.querySelectorAll("h1")).find(function (item) {
      var text = normalize(item.textContent);
      return text === "calendario de trabajos" || text.includes("actividades");
    });
    if (!heading || !state || document.querySelector(".activity-finder")) return;
    var topbar = heading.closest(".topbar");
    if (!topbar) return;
    var section = document.createElement("section");
    section.className = "activity-finder";
    section.innerHTML = '<label><span>Buscar actividad o cliente</span><input type="search" placeholder="Nombre, teléfono, orden, dirección o técnico" autocomplete="off"></label><div class="activity-finder-results" hidden></div>';
    topbar.insertAdjacentElement("afterend", section);
    var input = section.querySelector("input");
    var results = section.querySelector(".activity-finder-results");
    input.addEventListener("input", function () {
      var query = normalize(input.value);
      if (query.length < 2) { results.hidden = true; results.innerHTML = ""; return; }
      var matches = (Array.isArray(state.workOrders) ? state.workOrders : []).filter(function (work) { return searchText(work).includes(query); }).slice(0, 12);
      results.hidden = false;
      results.innerHTML = matches.length ? matches.map(function (work) {
        return '<button type="button" data-open-work="' + escapeHtml(work.code) + '"><strong>' + escapeHtml(work.code + " · " + work.client) + '</strong><span>' + escapeHtml((work.type || work.title || "Actividad") + " · " + (work.status || "Sin estado") + " · " + (work.plannedDate || work.dueDate || "Sin fecha")) + "</span></button>";
      }).join("") : '<p>No se encontraron actividades.</p>';
    });
    results.addEventListener("click", function (event) {
      var button = event.target.closest("[data-open-work]");
      if (button) openWork(button.dataset.openWork);
    });
  }

  function refresh(force) {
    loadState(force).then(function () { installSearch(); decorateAgenda(); }).catch(function () {});
  }

  function scan() {
    clearTimeout(timer);
    timer = window.setTimeout(function () { if (state) { installSearch(); decorateAgenda(); } else refresh(false); }, 80);
  }

  document.addEventListener("click", function (event) {
    var nav = event.target.closest("nav button");
    if (!nav) return;
    var text = normalize(nav.textContent);
    if (text === "agenda" || text === "actividades" || text === "mis actividades") refresh(true);
  }, true);
  document.addEventListener("change", function (event) {
    if (event.target.matches(".calendar-month-select select")) window.setTimeout(decorateAgenda, 80);
  }, true);
  new MutationObserver(scan).observe(document.documentElement, { childList: true, subtree: true });
  document.addEventListener("DOMContentLoaded", function () { refresh(false); });
  refresh(false);
})();

(function () {
  "use strict";

  var state = { users: [], shifts: [], userId: "", mode: "Turno", suggestionNumber: 0, month: new Date(new Date().getFullYear(), new Date().getMonth(), 1), dirty: false };
  var weekdays = ["Lun", "Mar", "Mie", "Jue", "Vie", "Sab", "Dom"];

  function escapeHtml(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, function (char) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[char];
    });
  }

  function dateKey(year, month, day) {
    return year + "-" + String(month + 1).padStart(2, "0") + "-" + String(day).padStart(2, "0");
  }

  function statusFor(date) {
    var item = state.shifts.find(function (shift) { return shift.userId === state.userId && shift.date === date; });
    return item ? item.status : "";
  }

  function isoDate(date) {
    return dateKey(date.getFullYear(), date.getMonth(), date.getDate());
  }

  function easterSunday(year) {
    var a = year % 19, b = Math.floor(year / 100), c = year % 100, d = Math.floor(b / 4), e = b % 4;
    var f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30;
    var i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7;
    var m = Math.floor((a + 11 * h + 22 * l) / 451), month = Math.floor((h + l - 7 * m + 114) / 31);
    return new Date(year, month - 1, ((h + l - 7 * m + 114) % 31) + 1);
  }

  function mondayHoliday(year, month, day) {
    var date = new Date(year, month, day), weekday = date.getDay();
    if (weekday >= 2 && weekday <= 4) date.setDate(date.getDate() - (weekday - 1));
    else if (weekday === 5) date.setDate(date.getDate() + 3);
    return date;
  }

  function reformationHoliday(year) {
    var date = new Date(year, 9, 31), weekday = date.getDay();
    if (weekday === 2) date.setDate(date.getDate() - 4);
    else if (weekday === 3) date.setDate(date.getDate() + 2);
    return date;
  }

  function holidaysFor(year) {
    var easter = easterSunday(year), goodFriday = new Date(easter), holySaturday = new Date(easter);
    goodFriday.setDate(easter.getDate() - 2);
    holySaturday.setDate(easter.getDate() - 1);
    var list = [
      [new Date(year, 0, 1), "Año Nuevo", true],
      [goodFriday, "Viernes Santo", false], [holySaturday, "Sábado Santo", false],
      [new Date(year, 4, 1), "Día del Trabajo", true], [new Date(year, 4, 21), "Glorias Navales", false],
      [new Date(year, 5, 21), "Día Nacional de los Pueblos Indígenas", false],
      [mondayHoliday(year, 5, 29), "San Pedro y San Pablo", false],
      [new Date(year, 6, 16), "Virgen del Carmen", false], [new Date(year, 7, 15), "Asunción de la Virgen", false],
      [new Date(year, 8, 18), "Independencia Nacional", true], [new Date(year, 8, 19), "Glorias del Ejército", true],
      [mondayHoliday(year, 9, 12), "Encuentro de Dos Mundos", false],
      [reformationHoliday(year), "Día de las Iglesias Evangélicas y Protestantes", false],
      [new Date(year, 10, 1), "Día de Todos los Santos", false], [new Date(year, 11, 8), "Inmaculada Concepción", false],
      [new Date(year, 11, 25), "Navidad", true]
    ];
    var september18 = new Date(year, 8, 18);
    if (september18.getDay() === 2) list.push([new Date(year, 8, 17), "Feriado adicional de Fiestas Patrias", false]);
    if (september18.getDay() === 3) list.push([new Date(year, 8, 20), "Feriado adicional de Fiestas Patrias", false]);
    return list.reduce(function (map, item) { map[isoDate(item[0])] = { name: item[1], mandatory: item[2] }; return map; }, {});
  }

  // Agenda uses the same official calendar so both modules always agree.
  window.BPGOHolidaysFor = holidaysFor;

  function suggestFiveByTwo() {
    if (!state.userId) return;
    var year = state.month.getFullYear(), month = state.month.getMonth();
    var totalDays = new Date(year, month + 1, 0).getDate(), holidays = holidaysFor(year);
    var userIndex = Math.max(0, state.users.findIndex(function (user) { return user.id === state.userId; }));
    var rotatingRestDays = [2, 3, 4], weeklyChoices = {};
    state.shifts = state.shifts.filter(function (shift) {
      return !(shift.userId === state.userId && shift.date.slice(0, 7) === year + "-" + String(month + 1).padStart(2, "0"));
    });
    for (var day = 1; day <= totalDays; day += 1) {
      var date = new Date(year, month, day), key = dateKey(year, month, day);
      if (holidays[key]) continue;
      var monday = new Date(date);
      monday.setDate(date.getDate() - ((date.getDay() + 6) % 7));
      var weekNumber = Math.floor((monday - new Date(year, 0, 1)) / 604800000);
      if (weeklyChoices[weekNumber] == null) {
        var random = new Uint32Array(1);
        crypto.getRandomValues(random);
        weeklyChoices[weekNumber] = rotatingRestDays[(random[0] + userIndex) % rotatingRestDays.length];
      }
      var secondRestDay = weeklyChoices[weekNumber];
      var status = date.getDay() === 0 || date.getDay() === secondRestDay ? "Descanso" : "Turno";
      state.shifts.push({ id: "shift-" + state.userId + "-" + key, userId: state.userId, date: key, status: status });
    }
    state.suggestionNumber += 1;
    state.dirty = true;
    render();
    var statusBox = document.querySelector(".shift-save-status");
    if (statusBox) statusBox.textContent = "Sugerencia aleatoria #" + state.suggestionNumber + " preparada: domingos libres y segundo descanso semanal sorteado entre martes, miércoles y jueves. Presiona nuevamente para obtener otra opción.";
  }

  function render() {
    var mount = document.querySelector("#technician-shifts-page");
    if (!mount) return;
    var year = state.month.getFullYear();
    var month = state.month.getMonth();
    var blanks = (new Date(year, month, 1).getDay() + 6) % 7;
    var totalDays = new Date(year, month + 1, 0).getDate();
    var monthLabel = new Intl.DateTimeFormat("es-CL", { month: "long", year: "numeric" }).format(state.month);
    var holidays = holidaysFor(year);
    var cells = Array(blanks).fill('<span class="shift-day empty"></span>');
    for (var day = 1; day <= totalDays; day += 1) {
      var key = dateKey(year, month, day);
      var holiday = holidays[key];
      var status = holiday ? "Feriado" : statusFor(key);
      var statusClass = holiday ? "holiday" + (holiday.mandatory ? " mandatory" : "") : status === "Turno" ? "work" : status === "Descanso" ? "rest" : status === "Feriado" ? "holiday manual" : "";
      var label = holiday ? holiday.name + (holiday.mandatory ? " · Irrenunciable" : "") : status;
      cells.push('<button class="shift-day ' + statusClass + '" data-shift-date="' + key + '"' + (holiday ? ' data-auto-holiday="true" title="Feriado oficial de Chile"' : "") + ' type="button"><strong>' + day + '</strong>' + (label ? '<span>' + escapeHtml(label) + '</span>' : "") + '</button>');
    }
    mount.innerHTML = '<div class="topbar"><div><p class="eyebrow">Operaciones</p><h1>Turnos de técnicos</h1><p class="muted">Calendario independiente para organizar días de turno y descanso.</p></div></div>' +
      '<section class="panel shift-calendar-panel">' +
      '<div class="shift-toolbar"><label class="field shift-technician"><span>Técnico</span><select id="shift-technician">' + state.users.map(function (user) { return '<option value="' + escapeHtml(user.id) + '"' + (user.id === state.userId ? " selected" : "") + '>' + escapeHtml(user.name) + '</option>'; }).join("") + '</select></label>' +
      '<div class="shift-mode"><span>Elige qué quieres marcar. Para borrar, toca nuevamente cualquier día marcado:</span><button class="shift-mode-btn work ' + (state.mode === "Turno" ? "active" : "") + '" data-shift-mode="Turno" type="button"><i></i> Turno</button><button class="shift-mode-btn rest ' + (state.mode === "Descanso" ? "active" : "") + '" data-shift-mode="Descanso" type="button"><i></i> Descanso</button><button class="shift-mode-btn holiday ' + (state.mode === "Feriado" ? "active" : "") + '" data-shift-mode="Feriado" type="button"><i></i> Feriado</button><div class="shift-suggestion-control"><div><strong>Sugerencia automática 5x2</strong><small>Cada clic genera una distribución aleatoria diferente.</small></div><button class="btn shift-suggest-btn" id="suggest-shifts" type="button">Sugerir turnos aleatorios</button></div></div></div>' +
      (state.users.length ? "" : '<div class="notice">No hay técnicos activos disponibles.</div>') +
      '<div class="shift-month-head"><button class="btn secondary" data-shift-month="-1" type="button">Mes anterior</button><h2>' + escapeHtml(monthLabel) + '</h2><button class="btn secondary" data-shift-month="1" type="button">Mes siguiente</button></div>' +
      '<div class="shift-weekdays">' + weekdays.map(function (name) { return "<strong>" + name + "</strong>"; }).join("") + '</div><div class="shift-calendar-grid">' + cells.join("") + '</div>' +
      '<div class="shift-footer"><div class="shift-legend"><span><i class="work"></i>Turno</span><span><i class="rest"></i>Descanso</span><span><i class="holiday"></i>Feriado</span><span><i class="mandatory"></i>Irrenunciable</span></div><button class="btn" id="save-shifts" type="button"' + (state.dirty ? "" : " disabled") + '>' + (state.dirty ? "Guardar calendario" : "Calendario guardado") + '</button></div><div class="shift-save-status" aria-live="polite"></div></section>';
  }

  async function openShifts() {
    var shell = document.querySelector(".app-shell");
    var content = shell && shell.querySelector("main.content");
    if (!shell || !content) return;
    var existing = document.querySelector("#technician-shifts-page");
    if (existing) existing.remove();
    shell.classList.add("shifts-page-open");
    document.querySelectorAll(".bpgo-shifts-nav").forEach(function (button) { button.classList.add("active"); });
    var mount = document.createElement("div");
    mount.id = "technician-shifts-page";
    content.appendChild(mount);
    mount.innerHTML = '<section class="panel"><p>Cargando turnos...</p></section>';
    try {
      var response = await fetch("/api/state?turnos=" + Date.now(), { cache: "no-store" });
      var result = await response.json();
      var data = result.data || {};
      var active = (data.users || []).filter(function (user) { return user.active !== false && user.role !== "super_admin"; });
      state.users = active.length ? active : (data.users || []).filter(function (user) { return user.active !== false; });
      state.shifts = Array.isArray(data.technicianShifts) ? data.technicianShifts.slice() : [];
      state.userId = state.users[0] ? state.users[0].id : "";
      state.dirty = false;
      render();
    } catch (error) {
      mount.innerHTML = '<section class="panel"><div class="notice danger">No se pudieron cargar los turnos. Revisa tu conexión e inténtalo nuevamente.</div></section>';
    }
  }

  function closeShifts() {
    var shell = document.querySelector(".app-shell");
    if (shell) shell.classList.remove("shifts-page-open");
    var mount = document.querySelector("#technician-shifts-page");
    if (mount) mount.remove();
    document.querySelectorAll(".bpgo-shifts-nav").forEach(function (button) { button.classList.remove("active"); });
  }

  function installNav() {
    document.querySelectorAll("nav.nav, nav.mobile-nav").forEach(function (nav) {
      if (nav.querySelector(".bpgo-shifts-nav")) return;
      var button = document.createElement("button");
      button.type = "button";
      button.className = "bpgo-shifts-nav";
      button.innerHTML = '<span class="shift-nav-icon">T</span><span>Turnos</span>';
      var agenda = Array.from(nav.querySelectorAll("button")).find(function (item) { return item.textContent.trim() === "Agenda"; });
      if (agenda && agenda.nextSibling) nav.insertBefore(button, agenda.nextSibling); else nav.appendChild(button);
    });
  }

  document.addEventListener("click", function (event) {
    var shiftNav = event.target.closest(".bpgo-shifts-nav");
    if (shiftNav) { event.preventDefault(); openShifts(); return; }
    var normalNav = event.target.closest("nav.nav button:not(.bpgo-shifts-nav), nav.mobile-nav button:not(.bpgo-shifts-nav)");
    if (normalNav) closeShifts();
    var mode = event.target.closest("[data-shift-mode]");
    if (mode) { state.mode = mode.dataset.shiftMode; render(); return; }
    var monthButton = event.target.closest("[data-shift-month]");
    if (monthButton) { state.month = new Date(state.month.getFullYear(), state.month.getMonth() + Number(monthButton.dataset.shiftMonth), 1); render(); return; }
    var day = event.target.closest("[data-shift-date]");
    if (day && state.userId) {
      if (day.dataset.autoHoliday === "true") return;
      var date = day.dataset.shiftDate;
      var previousStatus = statusFor(date);
      state.shifts = state.shifts.filter(function (shift) { return !(shift.userId === state.userId && shift.date === date); });
      if (!previousStatus) state.shifts.push({ id: "shift-" + state.userId + "-" + date, userId: state.userId, date: date, status: state.mode });
      state.dirty = true;
      render();
      return;
    }
    if (event.target.closest("#suggest-shifts")) { suggestFiveByTwo(); return; }
    if (event.target.closest("#save-shifts")) saveShifts();
  });

  document.addEventListener("change", function (event) {
    if (event.target.id === "shift-technician") { state.userId = event.target.value; render(); }
  });

  async function saveShifts() {
    var button = document.querySelector("#save-shifts");
    var status = document.querySelector(".shift-save-status");
    if (button) { button.disabled = true; button.textContent = "Guardando..."; }
    try {
      var response = await fetch("/api/state?turnos-save=" + Date.now(), { cache: "no-store" });
      var result = await response.json();
      var data = result.data || {};
      data.technicianShifts = state.shifts;
      var saved = await fetch("/api/state", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ data: data }) });
      if (!saved.ok) throw new Error("No autorizado");
      state.dirty = false;
      render();
      status = document.querySelector(".shift-save-status");
      if (status) status.textContent = "Turnos guardados correctamente en Cloudflare.";
    } catch (error) {
      if (button) { button.disabled = false; button.textContent = "Reintentar guardado"; }
      if (status) status.textContent = "No se pudieron guardar los turnos. Vuelve a iniciar sesión e inténtalo nuevamente.";
    }
  }

  new MutationObserver(installNav).observe(document.documentElement, { childList: true, subtree: true });
  document.addEventListener("DOMContentLoaded", installNav);
  installNav();
})();

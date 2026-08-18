(function () {
  "use strict";

  var cachedState = null;
  var loadingState = null;
  var agendaVisible = false;
  var scanTimer = 0;

  function normalize(value) {
    return String(value || "").trim().toLocaleLowerCase("es-CL");
  }

  function loadState(force) {
    if (loadingState) return loadingState;
    if (cachedState && !force) return Promise.resolve(cachedState);
    loadingState = fetch("/api/state?agenda-disponibilidad=" + Date.now(), { cache: "no-store" })
      .then(function (response) {
        if (!response.ok) throw new Error("No se pudo consultar la disponibilidad");
        return response.json();
      })
      .then(function (result) {
        cachedState = result.data || {};
        return cachedState;
      })
      .finally(function () { loadingState = null; });
    return loadingState;
  }

  function userName(id) {
    var users = cachedState && Array.isArray(cachedState.users) ? cachedState.users : [];
    var user = users.find(function (item) { return item.id === id; });
    return user ? (user.name || user.email || "Técnico") : "Técnico";
  }

  function availability(form) {
    var dateInput = form.querySelector('input[name="plannedDate"]');
    var date = dateInput && dateInput.value;
    var selected = Array.from(form.querySelectorAll('input[name="assignedToIds"]:checked')).map(function (input) { return input.value; });
    if (!date || !selected.length) return { ready: true, conflict: false, message: "" };
    if (!cachedState) return { ready: false, conflict: false, message: "Consultando turnos del equipo…" };

    var shifts = Array.isArray(cachedState.technicianShifts) ? cachedState.technicianShifts : [];
    var conflicts = selected.map(function (id) {
      var shift = shifts.find(function (item) { return item.userId === id && item.date === date; });
      return shift && (shift.status === "Descanso" || shift.status === "Feriado")
        ? { id: id, name: userName(id), status: shift.status }
        : null;
    }).filter(Boolean);

    var year = Number(date.slice(0, 4));
    var holidays = typeof window.BPGOHolidaysFor === "function" ? window.BPGOHolidaysFor(year) : {};
    var holiday = holidays[date];
    var prettyDate = new Intl.DateTimeFormat("es-CL", { weekday: "long", day: "numeric", month: "long" }).format(new Date(date + "T12:00:00"));

    if (holiday) {
      return {
        ready: true,
        conflict: true,
        message: "No se puede asignar esta actividad el " + prettyDate + ": corresponde a " + holiday.name + (holiday.mandatory ? " (feriado irrenunciable)." : " (feriado).")
      };
    }
    if (conflicts.length) {
      var names = conflicts.map(function (item) { return item.name; }).join(", ");
      var statuses = Array.from(new Set(conflicts.map(function (item) { return item.status.toLocaleLowerCase("es-CL"); }))).join(" o ");
      return {
        ready: true,
        conflict: true,
        message: "No se puede asignar esta actividad el " + prettyDate + ": " + names + " está con " + statuses + ". Elige otro técnico o una fecha disponible."
      };
    }
    return { ready: true, conflict: false, message: "Disponibilidad validada: los técnicos seleccionados pueden trabajar en esta fecha." };
  }

  function statusBox(form) {
    var box = form.querySelector(".agenda-shift-availability");
    if (box) return box;
    box = document.createElement("div");
    box.className = "agenda-shift-availability";
    box.setAttribute("role", "status");
    box.setAttribute("aria-live", "polite");
    var assignee = form.querySelector('input[name="assignedToIds"]');
    var field = assignee && assignee.closest(".field");
    if (field && field.parentNode) field.parentNode.insertBefore(box, field.nextSibling);
    else form.insertBefore(box, form.querySelector('button[type="submit"]'));
    return box;
  }

  function updateForm(form) {
    if (!form || !form.querySelector('input[name="plannedDate"]') || !form.querySelector('input[name="assignedToIds"]')) return;
    var result = availability(form);
    var box = statusBox(form);
    var hasValues = form.querySelector('input[name="plannedDate"]').value && form.querySelector('input[name="assignedToIds"]:checked');
    box.textContent = hasValues ? result.message : "Selecciona fecha y técnico para validar su turno antes de guardar.";
    box.className = "agenda-shift-availability " + (!hasValues ? "neutral" : !result.ready ? "checking" : result.conflict ? "blocked" : "available");
    var submit = form.querySelector('button[type="submit"]');
    if (!submit) return;
    if (result.conflict) {
      if (!submit.disabled) submit.dataset.shiftGuardDisabled = "true";
      submit.disabled = true;
      submit.setAttribute("aria-describedby", "agenda-shift-warning");
      box.id = "agenda-shift-warning";
    } else if (submit.dataset.shiftGuardDisabled === "true") {
      submit.disabled = false;
      delete submit.dataset.shiftGuardDisabled;
      submit.removeAttribute("aria-describedby");
      box.removeAttribute("id");
    }
  }

  function installForms() {
    var forms = Array.from(document.querySelectorAll("form")).filter(function (form) {
      return form.querySelector('input[name="plannedDate"]') && form.querySelector('input[name="assignedToIds"]');
    });
    if (!forms.length) return;
    var newForms = forms.filter(function (form) { return form.dataset.shiftGuardInstalled !== "true"; });
    if (!newForms.length) return;
    newForms.forEach(function (form) { form.dataset.shiftGuardInstalled = "true"; });
    loadState(!cachedState).then(function () { newForms.forEach(updateForm); }).catch(function () {
      newForms.forEach(function (form) {
        var box = statusBox(form);
        box.className = "agenda-shift-availability blocked";
        box.textContent = "No fue posible validar los turnos. Revisa la conexión antes de asignar.";
      });
    });
    forms.forEach(updateForm);
  }

  function focusCurrentWeek() {
    var title = Array.from(document.querySelectorAll("h1, h2")).find(function (item) {
      var text = normalize(item.textContent);
      return text === "calendario mensual" || text === "calendario semanal";
    });
    if (!title) { agendaVisible = false; return; }
    var panel = title.closest("section") || title.parentElement.parentElement;
    if (normalize(title.textContent) === "calendario semanal") {
      agendaVisible = true;
      panel.removeAttribute("data-current-week-positioned");
      return;
    }
    agendaVisible = true;
    if (panel.dataset.currentWeekPositioned === "true") return;
    var monthSelect = panel.querySelector(".calendar-month-select select");
    var now = new Date();
    var currentMonth = now.getFullYear() + "-" + String(now.getMonth() + 1).padStart(2, "0");
    if (!monthSelect || monthSelect.value !== currentMonth) return;
    var today = Array.from(panel.querySelectorAll(".month-grid .day-column:not(.outside-month)")).find(function (column) {
      var heading = column.querySelector(".day-head strong");
      var match = heading && heading.textContent.match(/(\d{1,2})\s*$/);
      return match && Number(match[1]) === now.getDate();
    });
    if (!today) return;
    panel.dataset.currentWeekPositioned = "true";
    today.classList.add("agenda-today-column");
    setTimeout(function () { today.scrollIntoView({ behavior: "smooth", block: "center", inline: "nearest" }); }, 80);
  }

  function scan() {
    clearTimeout(scanTimer);
    scanTimer = setTimeout(function () {
      focusCurrentWeek();
      installForms();
    }, 40);
  }

  document.addEventListener("change", function (event) {
    if (!event.target.matches('input[name="plannedDate"], input[name="assignedToIds"]')) return;
    updateForm(event.target.closest("form"));
  }, true);

  document.addEventListener("submit", function (event) {
    var form = event.target;
    if (!form.querySelector || !form.querySelector('input[name="plannedDate"]') || !form.querySelector('input[name="assignedToIds"]')) return;
    var result = availability(form);
    if (!result.ready || result.conflict) {
      event.preventDefault();
      event.stopImmediatePropagation();
      updateForm(form);
      window.alert(result.ready ? result.message : "Espera un momento mientras se validan los turnos del equipo.");
    }
  }, true);

  document.addEventListener("click", function (event) {
    var button = event.target.closest("nav button");
    if (button && normalize(button.textContent) === "agenda") {
      agendaVisible = false;
      cachedState = null;
      scan();
    }
  }, true);

  new MutationObserver(scan).observe(document.documentElement, { childList: true, subtree: true });
  document.addEventListener("DOMContentLoaded", scan);
  scan();
})();

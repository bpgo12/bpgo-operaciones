(function () {
  "use strict";

  var mode = "actual";
  var scanTimer = 0;

  function parseAmount(text) {
    var match = String(text || "").match(/\$\s*([\d.]+)/);
    if (!match) return 0;
    return Number(match[1].replace(/\./g, "")) || 0;
  }

  function setText(node, value) {
    if (node && node.textContent !== value) node.textContent = value;
  }

  function findPanel() {
    var heading = Array.from(document.querySelectorAll("h2")).find(function (h) {
      return h.textContent.trim() === "Clientes suspendidos";
    });
    return heading ? heading.closest("section") : null;
  }

  function ensureToggle(panel) {
    var head = panel.querySelector(".panel-head");
    if (!head) return;
    var existingToggle = head.nextElementSibling && head.nextElementSibling.classList.contains("susp-month-toggle")
      ? head.nextElementSibling
      : null;
    if (existingToggle) return;
    var toggle = document.createElement("div");
    toggle.className = "susp-month-toggle";
    toggle.innerHTML =
      '<button type="button" data-susp-mode="actual" class="btn small">Mes actual</button>' +
      '<button type="button" data-susp-mode="historico" class="btn secondary small">Historicos</button>';
    head.insertAdjacentElement("afterend", toggle);
    toggle.addEventListener("click", function (event) {
      var button = event.target.closest("[data-susp-mode]");
      if (!button) return;
      mode = button.dataset.suspMode;
      apply();
    });
  }

  function apply() {
    var panel = findPanel();
    if (!panel) return;
    ensureToggle(panel);

    var toggle = panel.querySelector(".susp-month-toggle");
    if (toggle) {
      Array.from(toggle.querySelectorAll("[data-susp-mode]")).forEach(function (button) {
        var active = button.dataset.suspMode === mode;
        var nextClass = "btn small" + (active ? "" : " secondary");
        if (button.className !== nextClass) button.className = nextClass;
      });
    }

    var rows = Array.prototype.slice.call(panel.querySelectorAll("tbody tr"));
    var visibleCount = 0;
    var sinTelefono = 0;
    var monto = 0;

    rows.forEach(function (row) {
      var estadoCell = row.querySelector('[data-label="Estado actual"]');
      var estadoText = estadoCell ? estadoCell.textContent.trim() : "";
      var isCurrent = estadoText === "Suspendido actual";
      var show = mode === "actual" ? isCurrent : !isCurrent;
      var nextDisplay = show ? "" : "none";
      if (row.style.display !== nextDisplay) row.style.display = nextDisplay;
      if (!show) return;
      visibleCount += 1;
      var phoneCell = row.querySelector('[data-label="WhatsApp"]');
      if (!phoneCell || !phoneCell.textContent.trim()) sinTelefono += 1;
      var planCell = row.querySelector('[data-label="Plan / monto"] .table-note');
      monto += parseAmount(planCell ? planCell.textContent : "");
    });

    var kpis = panel.querySelectorAll(".campaign-kpis strong");
    setText(kpis[0], String(visibleCount));
    setText(kpis[2], String(sinTelefono));
    setText(kpis[3], "$" + monto.toLocaleString("es-CL"));

    var kpiLabels = panel.querySelectorAll(".campaign-kpis span");
    if (kpiLabels[0]) {
      var suffix = mode === "actual" ? " (mes actual)" : " (historicos)";
      var existing = kpiLabels[0].querySelector(".susp-mode-suffix");
      if (!existing) {
        existing = document.createElement("small");
        existing.className = "susp-mode-suffix";
        kpiLabels[0].appendChild(existing);
      }
      setText(existing, suffix);
    }

    var badge = panel.querySelector(".panel-head .pill");
    setText(badge, visibleCount + " visibles");
  }

  function scan() {
    clearTimeout(scanTimer);
    scanTimer = window.setTimeout(apply, 120);
  }

  new MutationObserver(scan).observe(document.documentElement, { childList: true, subtree: true });
  document.addEventListener("DOMContentLoaded", apply);
  apply();
})();

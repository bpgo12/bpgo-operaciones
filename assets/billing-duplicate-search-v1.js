(function () {
  "use strict";

  var state = null;
  var loading = null;
  var timer = 0;

  function normalize(value) {
    return String(value || "").normalize("NFD").replace(/[̀-ͯ]/g, "").trim().toLowerCase();
  }

  function escapeHtml(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, function (char) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[char];
    });
  }

  function loadState(force) {
    if (loading) return loading;
    if (state && !force) return Promise.resolve(state);
    loading = fetch("/api/state?billing-dup-search=" + Date.now(), { cache: "no-store" })
      .then(function (response) { if (!response.ok) throw new Error("state"); return response.json(); })
      .then(function (result) { state = result.data || {}; return state; })
      .finally(function () { loading = null; });
    return loading;
  }

  function matches(customer, query) {
    var haystack = normalize([customer.customerName, customer.phone, customer.address, customer.sector].join(" "));
    return haystack.includes(query);
  }

  function setInputValue(input, value) {
    var setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }

  function renderResults(panel, input, query) {
    var customers = (state && Array.isArray(state.billingCustomers) ? state.billingCustomers : []).filter(function (customer) {
      return matches(customer, query);
    });
    var names = {};
    customers.forEach(function (customer) { names[normalize(customer.customerName)] = (names[normalize(customer.customerName)] || 0) + 1; });
    var hasDuplicateNames = Object.keys(names).some(function (key) { return names[key] > 1; });
    if (!hasDuplicateNames || customers.length < 2) {
      panel.hidden = true;
      panel.innerHTML = "";
      return;
    }
    panel.hidden = false;
    panel.innerHTML =
      '<p class="bds-hint">Hay ' + customers.length + ' clientes que coinciden. Toca el que corresponde para filtrar por su teléfono exacto:</p>' +
      customers.slice(0, 20).map(function (customer) {
        return '<button type="button" class="bds-item" data-bds-phone="' + escapeHtml(customer.phone || "") + '">' +
          '<strong>' + escapeHtml(customer.customerName || "Sin nombre") + '</strong>' +
          '<span>' + escapeHtml(customer.phone || "Sin teléfono") + (customer.address ? " · " + escapeHtml(customer.address) : "") + (customer.sector ? " · " + escapeHtml(customer.sector) : "") + '</span>' +
          '</button>';
      }).join("");
  }

  function install() {
    var input = document.querySelector(".billing-search-field input");
    if (!input) {
      var stalePanel = document.querySelector(".billing-duplicate-search");
      if (stalePanel) stalePanel.remove();
      return;
    }
    var field = input.closest(".billing-search-field");
    var panel = field.nextElementSibling && field.nextElementSibling.classList.contains("billing-duplicate-search")
      ? field.nextElementSibling
      : null;
    if (!panel) {
      panel = document.createElement("div");
      panel.className = "billing-duplicate-search";
      panel.hidden = true;
      field.insertAdjacentElement("afterend", panel);
    }
    if (input.dataset.bdsBound === "true") return;
    input.dataset.bdsBound = "true";
    input.addEventListener("input", function () {
      clearTimeout(timer);
      var query = normalize(input.value);
      if (query.length < 3) { panel.hidden = true; panel.innerHTML = ""; return; }
      timer = window.setTimeout(function () {
        loadState(false).then(function () { renderResults(panel, input, query); }).catch(function () {});
      }, 150);
    });
  }

  document.addEventListener("click", function (event) {
    var item = event.target.closest("[data-bds-phone]");
    if (!item) return;
    var phone = item.dataset.bdsPhone;
    if (!phone) return;
    var input = document.querySelector(".billing-search-field input");
    if (!input) return;
    setInputValue(input, phone);
    var panel = document.querySelector(".billing-duplicate-search");
    if (panel) { panel.hidden = true; panel.innerHTML = ""; }
  });

  var scanTimer = 0;
  function scan() {
    clearTimeout(scanTimer);
    scanTimer = window.setTimeout(install, 90);
  }
  new MutationObserver(scan).observe(document.documentElement, { childList: true, subtree: true });
  document.addEventListener("DOMContentLoaded", install);
  install();
})();

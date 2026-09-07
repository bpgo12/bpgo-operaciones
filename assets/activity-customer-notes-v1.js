(function () {
  "use strict";

  var state = null;
  var loading = null;
  var scanTimer = 0;

  function loadState(force) {
    if (loading) return loading;
    if (state && !force) return Promise.resolve(state);
    loading = fetch("/api/state?activity-notes=" + Date.now(), { cache: "no-store" })
      .then(function (response) { if (!response.ok) throw new Error("state"); return response.json(); })
      .then(function (result) { state = result.data || {}; return state; })
      .finally(function () { loading = null; });
    return loading;
  }

  function codeFromMuted(text) {
    var match = String(text || "").match(/^([A-Z0-9-]+)\s*\|/);
    return match ? match[1] : "";
  }

  function apply() {
    var sections = document.querySelectorAll(".detail-section");
    if (!sections.length) return;
    loadState(false).then(function (data) {
      var workOrders = Array.isArray(data.workOrders) ? data.workOrders : [];
      var customers = Array.isArray(data.customers) ? data.customers : [];
      sections.forEach(function (section) {
        var mutedEl = section.querySelector(".panel-head .muted");
        var notice = section.querySelector(".notice");
        if (!mutedEl || !notice) return;
        var code = codeFromMuted(mutedEl.textContent);
        if (!code) return;
        if (notice.dataset.obsCode === code) return;
        var work = workOrders.find(function (w) { return w.code === code; });
        if (!work) return;
        var customer = customers.find(function (c) { return c.id === work.customerId; });
        var accessNotes = customer && customer.accessNotes ? customer.accessNotes.trim() : "";
        notice.dataset.obsCode = code;
        if (accessNotes) {
          notice.innerHTML = "<strong>Observaciones del cliente:</strong> " + accessNotes.replace(/[&<>"']/g, function (char) {
            return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[char];
          });
        }
      });
    }).catch(function () {});
  }

  function scan() {
    clearTimeout(scanTimer);
    scanTimer = window.setTimeout(apply, 120);
  }

  new MutationObserver(scan).observe(document.documentElement, { childList: true, subtree: true });
  document.addEventListener("DOMContentLoaded", apply);
  apply();
})();

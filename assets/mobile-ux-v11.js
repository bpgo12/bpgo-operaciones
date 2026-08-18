(function () {
  "use strict";

  const mobileQuery = window.matchMedia("(max-width: 640px)");

  function detailPanel() {
    return document.getElementById("work-detail-panel");
  }

  function ensureBackButton() {
    const panel = detailPanel();
    if (!panel || panel.querySelector(".mobile-back-to-list")) return;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "btn secondary mobile-back-to-list";
    button.textContent = "← Volver a actividades";
    button.addEventListener("click", function () {
      document.body.classList.remove("mobile-detail-open");
      const controls = document.querySelector(".work-control-panel");
      (controls || document.querySelector(".workspace"))?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
    panel.prepend(button);
  }

  function installBillingSearch() {
    const input = document.querySelector(".billing-search-field input");
    if (!input) {
      document.body?.classList.remove("mobile-billing-searching");
      return;
    }
    if (input.dataset.mobileSearchReady === "true") return;
    input.dataset.mobileSearchReady = "true";
    const update = function () {
      const active = mobileQuery.matches && input.value.trim().length > 0;
      document.body?.classList.toggle("mobile-billing-searching", active);
      if (active) {
        window.requestAnimationFrame(function () {
          document.querySelector(".billing-quick-pay")?.scrollIntoView({ behavior: "smooth", block: "nearest" });
        });
      }
    };
    input.addEventListener("input", update);
    input.addEventListener("search", update);
    update();
  }

  document.addEventListener("click", function (event) {
    if (!mobileQuery.matches) return;
    const card = event.target.closest && event.target.closest(".work-card-compact");
    if (!card) return;
    window.setTimeout(function () {
      ensureBackButton();
      document.body.classList.add("mobile-detail-open");
      detailPanel()?.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 0);
  }, true);

  document.addEventListener("click", function (event) {
    if (!mobileQuery.matches) return;
    const navigationButton = event.target.closest && event.target.closest(".mobile-nav button");
    if (navigationButton) document.body.classList.remove("mobile-detail-open");
  });

  const observer = new MutationObserver(function () {
    if (mobileQuery.matches && document.body && document.body.classList.contains("mobile-detail-open")) ensureBackButton();
    installBillingSearch();
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
  document.addEventListener("DOMContentLoaded", installBillingSearch);
})();

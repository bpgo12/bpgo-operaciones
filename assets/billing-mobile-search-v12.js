(function () {
  "use strict";
  const mobileQuery = window.matchMedia("(max-width: 640px)");

  function install() {
    const input = document.querySelector(".billing-search-field input");
    if (!input) {
      document.body?.classList.remove("mobile-billing-searching");
      return;
    }
    if (input.dataset.billingMobileV12 === "true") return;
    input.dataset.billingMobileV12 = "true";
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

  const observer = new MutationObserver(install);
  observer.observe(document.documentElement, { childList: true, subtree: true });
  document.addEventListener("DOMContentLoaded", install);
})();

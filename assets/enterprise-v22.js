(function () {
  "use strict";

  function installLogo(root) {
    (root || document).querySelectorAll(".brand-mark:not(.enterprise-logo-ready)").forEach(function (mark) {
      mark.classList.add("enterprise-logo-ready");
      mark.innerHTML = '<img src="/assets/bpgo-logo-v22.png" alt="BPGO">';
    });
  }

  function installPortal() {
    var portal = document.querySelector(".department-entry");
    if (!portal || portal.classList.contains("enterprise-portal-ready")) return;
    portal.classList.add("enterprise-portal-ready");
    var visual = document.createElement("aside");
    visual.className = "enterprise-planning-visual";
    visual.innerHTML = '<div class="enterprise-visual-brand"><img src="/assets/bpgo-logo-v22.png" alt="BPGO"><div><strong>Internet fibra óptica rural</strong><span>Planificación, terreno y gestión conectados</span></div></div><div class="enterprise-system-status"><span>Sistema operativo</span><strong><i></i> Todos los sistemas funcionando</strong><div><small>Red<br><b>Operativa</b></small><small>Seguridad<br><b>Sin alertas</b></small><small>Servicios<br><b>Estables</b></small></div></div>';
    var header = portal.querySelector(".department-entry-head");
    if (header && header.nextSibling) portal.insertBefore(visual, header.nextSibling);
    else portal.prepend(visual);
  }

  function labelPortal() {
    var hero = document.querySelector(".department-entry-hero");
    if (!hero || hero.querySelector(".enterprise-kicker")) return;
    var kicker = document.createElement("div");
    kicker.className = "enterprise-kicker";
    kicker.textContent = "CENTRO DE OPERACIONES";
    hero.prepend(kicker);
  }

  function enhance() {
    installLogo(document);
    installPortal();
    labelPortal();
    document.documentElement.classList.add("enterprise-theme-ready");
  }

  new MutationObserver(enhance).observe(document.documentElement, { childList: true, subtree: true });
  document.addEventListener("DOMContentLoaded", enhance);
  enhance();
})();

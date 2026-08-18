(function () {
  "use strict";

  var timer = 0;

  function normalize(value) {
    return String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim().toLowerCase();
  }

  function activityButton() {
    return Array.from(document.querySelectorAll(".sidebar .nav button")).find(function (button) {
      var text = normalize(button.textContent);
      return (text === "actividades" || text === "mis actividades") && button.classList.contains("active");
    });
  }

  function realNewWorkButton() {
    return Array.from(document.querySelectorAll("button")).find(function (button) {
      var text = normalize(button.textContent);
      return (text === "nuevo trabajo" || text === "nueva actividad") && !button.closest(".activity-command-bar, .activity-submenu");
    });
  }

  function scrollToElement(element) {
    if (!element) return;
    element.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function runAction(action) {
    if (action === "new") {
      var create = realNewWorkButton();
      if (create) create.click();
      return;
    }
    if (action === "search") {
      var input = document.querySelector(".activity-finder input") || document.querySelector(".global-search input");
      scrollToElement(input && (input.closest(".activity-finder") || input));
      window.setTimeout(function () { if (input) input.focus(); }, 250);
      return;
    }
    if (action === "summary") {
      scrollToElement(document.querySelector("#bpgo-points-dashboard"));
      return;
    }
    if (action === "list") {
      var heading = Array.from(document.querySelectorAll("h1, h2")).find(function (item) { return normalize(item.textContent) === "trabajos bpgo"; });
      scrollToElement(heading && (heading.closest(".topbar") || heading));
    }
  }

  function menuMarkup(className) {
    return '<div class="' + className + '">' +
      '<button type="button" data-activity-action="new"><b>＋</b><span>Nueva actividad</span></button>' +
      '<button type="button" data-activity-action="search"><b>⌕</b><span>Buscar</span></button>' +
      '<button type="button" data-activity-action="summary"><b>▦</b><span>Resumen y puntos</span></button>' +
      '<button type="button" data-activity-action="list"><b>☷</b><span>Lista de trabajos</span></button>' +
      '</div>';
  }

  function install() {
    var active = activityButton();
    document.querySelectorAll(".activity-submenu, .activity-command-bar").forEach(function (item) {
      if (!active) item.remove();
    });
    if (!active) return;

    if (!document.querySelector(".activity-command-bar")) {
      var content = document.querySelector("main.content");
      var anchor = content && (content.querySelector(".breadcrumbs") || content.querySelector(".global-search"));
      if (anchor) {
        anchor.insertAdjacentHTML("afterend", '<section class="activity-command-bar"><div><strong>Gestión de actividades</strong><span>Accesos rápidos sin recorrer toda la página.</span></div>' + menuMarkup("activity-command-actions") + '</section>');
      }
    }
  }

  document.addEventListener("click", function (event) {
    var action = event.target.closest("[data-activity-action]");
    if (!action) return;
    event.preventDefault();
    runAction(action.dataset.activityAction);
  });

  function scan() {
    clearTimeout(timer);
    timer = window.setTimeout(install, 70);
  }

  new MutationObserver(scan).observe(document.documentElement, { childList: true, subtree: true });
  document.addEventListener("DOMContentLoaded", install);
  install();
})();

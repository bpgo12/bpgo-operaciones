(function () {
  "use strict";

  var labels = new Set([
    "inicio",
    "dashboard ops",
    "planificacion",
    "actividades",
    "mis actividades",
    "calidad",
    "agenda",
    "turnos",
    "clientes",
    "stock",
    "equipo",
    "ajustes"
  ]);

  function normalize(value) {
    return String(value || "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .trim()
      .toLowerCase();
  }

  function resetPosition() {
    var scrollingElement = document.scrollingElement || document.documentElement;
    if (scrollingElement) scrollingElement.scrollTop = 0;
    window.scrollTo(0, 0);

    document.querySelectorAll(".workspace, .main-content, main").forEach(function (element) {
      if (element.scrollHeight > element.clientHeight) element.scrollTop = 0;
    });
  }

  function openAtTop() {
    resetPosition();
    window.requestAnimationFrame(resetPosition);
    window.setTimeout(resetPosition, 80);
    window.setTimeout(resetPosition, 220);
  }

  document.addEventListener("click", function (event) {
    var button = event.target.closest(".sidebar .nav button, .mobile-nav button");
    if (!button || !labels.has(normalize(button.textContent))) return;
    openAtTop();
  }, false);
})();

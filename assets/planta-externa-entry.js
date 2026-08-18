(() => {
  const CARD_ID = "bpgo-planta-externa";

  function addCard() {
    const grid = document.querySelector(".department-grid");
    if (!grid || document.getElementById(CARD_ID)) return;

    const card = document.createElement("button");
    card.id = CARD_ID;
    card.className = "department-card";
    card.type = "button";
    card.setAttribute("aria-label", "Abrir Planta Externa GIS");
    card.innerHTML = `
      <span class="department-icon gis-department-icon" aria-hidden="true">⌘</span>
      <small>Infraestructura óptica</small>
      <strong>Planta Externa</strong>
      <p>Mapa GIS de OLT, cables, mufas, CTO, clientes, filamentos, potencia óptica e incidencias.</p>
      <div class="meta">
        <span class="pill">Red óptica</span>
        <span class="pill">Clientes</span>
        <span class="pill">Potencia</span>
      </div>`;
    card.addEventListener("click", () => {
      window.location.assign("/planta-externa/");
    });
    grid.appendChild(card);
  }

  const style = document.createElement("style");
  style.textContent = `
    .gis-department-icon{font-size:24px;font-weight:900;color:#fff}
    #${CARD_ID}{border-color:rgba(8,139,128,.25)}
    #${CARD_ID}:hover{border-color:#078b80;box-shadow:0 12px 26px rgba(7,139,128,.12)}
  `;
  document.head.appendChild(style);

  new MutationObserver(addCard).observe(document.documentElement, {
    childList: true,
    subtree: true,
  });
  addCard();
})();

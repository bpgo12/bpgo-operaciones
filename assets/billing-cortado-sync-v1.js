(function () {
  "use strict";

  const TOKEN_KEY = "bpgo-operaciones-auth-token";
  const SESSION_FLAG = "bpgo-cortado-sync-done";
  const NOTE = "Suspendido: figura CORTADO en planilla Registro de Pagos (ESTADO BPGO).";

  function normalizePhone(value) {
    return String(value || "").replace(/\D/g, "").slice(-8);
  }

  async function run() {
    if (sessionStorage.getItem(SESSION_FLAG)) return;
    const token = sessionStorage.getItem(TOKEN_KEY);
    if (!token) return;
    sessionStorage.setItem(SESSION_FLAG, "true");

    try {
      const cortadosResponse = await fetch("/api/billing/cortados", { cache: "no-store" });
      if (!cortadosResponse.ok) return;
      const cortadosPayload = await cortadosResponse.json().catch(function () { return {}; });
      const phones = Array.isArray(cortadosPayload.phones) ? cortadosPayload.phones : [];
      if (!phones.length) return;
      const cortadoSet = new Set(phones.map(normalizePhone));

      const stateResponse = await fetch("/api/state?cortado-sync=" + Date.now(), { cache: "no-store" });
      if (!stateResponse.ok) return;
      const stateResult = await stateResponse.json().catch(function () { return {}; });
      const state = stateResult.data;
      const customers = state && Array.isArray(state.billingCustomers) ? state.billingCustomers : [];
      if (!customers.length) return;

      let changed = false;
      customers.forEach(function (customer) {
        if (!cortadoSet.has(normalizePhone(customer.phone))) return;
        if (customer.active === false && customer.lastImportedStatus === "Suspendido") return;
        customer.active = false;
        customer.lastImportedStatus = "Suspendido";
        customer.notes = customer.notes && !customer.notes.includes(NOTE)
          ? customer.notes + " " + NOTE
          : (customer.notes || NOTE);
        changed = true;
      });

      if (!changed) return;
      await fetch("/api/state", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ data: state }),
      });
    } catch (error) {
      console.warn("No se pudo sincronizar clientes cortados", error);
    }
  }

  document.addEventListener("DOMContentLoaded", run);
  run();
})();

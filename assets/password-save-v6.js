(function () {
  "use strict";

  const nativeFetch = window.fetch.bind(window);
  const TOKEN_KEY = "bpgo-operaciones-auth-token";

  async function sendWhatsAppBatches(input, init, records) {
    const batchSize = 25;
    const results = [];
    for (let index = 0; index < records.length; index += batchSize) {
      const batch = records.slice(index, index + batchSize);
      const response = await nativeFetch(input, Object.assign({}, init, {
        body: JSON.stringify({ records: batch }),
      }));
      const payload = await response.json().catch(function () { return {}; });
      if (Array.isArray(payload.results)) results.push.apply(results, payload.results);
      if (!response.ok && !payload.results) {
        batch.forEach(function (record) {
          results.push({ id: record.id, phone: record.phone, ok: false, error: payload.error || "Error al enviar el lote" });
        });
      }
    }
    const sent = results.filter(function (item) { return item.ok; }).length;
    return new Response(JSON.stringify({
      ok: sent === records.length,
      sent: sent,
      failed: records.length - sent,
      results: results,
    }), { status: sent === 0 ? 422 : 200, headers: { "content-type": "application/json; charset=utf-8" } });
  }

  if (localStorage.getItem("bpgo-operaciones-session") && !sessionStorage.getItem(TOKEN_KEY)) {
    localStorage.removeItem("bpgo-operaciones-session");
  }

  window.fetch = function protectedFetch(input, init) {
    const url = typeof input === "string" ? input : input && input.url;
    const method = String((init && init.method) || (input && input.method) || "GET").toUpperCase();
    if (url && ((url.includes("/api/state") && method === "PUT") ||
      (url.includes("/api/whatsapp/send-billing") && method === "POST"))) {
      const headers = new Headers(init && init.headers || {});
      const token = sessionStorage.getItem(TOKEN_KEY);
      if (token) headers.set("authorization", "Bearer " + token);
      init = Object.assign({}, init, { headers: headers });
      if (url.includes("/api/whatsapp/send-billing") && method === "POST") {
        const payload = JSON.parse(String(init.body || "{}"));
        const records = Array.isArray(payload.records) ? payload.records : [];
        if (records.length > 25) return sendWhatsAppBatches(input, init, records);
      }
    }
    return nativeFetch(input, init);
  };

  document.addEventListener("submit", async function (event) {
    const form = event.target;
    if (!(form instanceof HTMLFormElement) || !form.closest(".login-page")) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    const data = new FormData(form);
    const response = await nativeFetch("/api/auth", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: String(data.get("email") || ""),
        password: String(data.get("password") || ""),
      }),
    }).catch(function () { return null; });
    if (response && response.ok) {
      const result = await response.json();
      localStorage.setItem("bpgo-operaciones-session", result.userId);
      sessionStorage.setItem(TOKEN_KEY, result.token);
      window.location.reload();
      return;
    }
    window.alert("Correo o contrasena incorrectos.");
  }, true);

  document.addEventListener("click", async function (event) {
    const button = event.target.closest && event.target.closest("button");
    if (!button || button.textContent.trim() !== "Ver") return;
    const cell = button.closest(".password-cell");
    const row = button.closest("tr");
    const passwordInput = cell && cell.querySelector("input");
    if (!passwordInput || passwordInput.value !== "********") return;
    const emailInput = row && Array.from(row.querySelectorAll("input")).find(function (input) {
      return String(input.value || "").includes("@");
    });
    const email = String(emailInput && emailInput.value || "").trim().toLowerCase();
    const token = sessionStorage.getItem(TOKEN_KEY);
    if (!email || !token) return;
    const response = await nativeFetch("/api/user-password?email=" + encodeURIComponent(email), {
      headers: { "authorization": "Bearer " + token },
      cache: "no-store",
    }).catch(function () { return null; });
    if (!response || !response.ok) {
      window.alert("No se pudo consultar la clave guardada.");
      return;
    }
    const result = await response.json();
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
    setter.call(passwordInput, result.password);
    passwordInput.dispatchEvent(new Event("input", { bubbles: true }));
  }, true);

  function findPasswordRows() {
    return Array.from(document.querySelectorAll(".password-cell")).filter(function (cell) {
      return cell.querySelector('input[type="password"], input[placeholder="Nueva contrasena"]');
    });
  }

  function installButtons() {
    findPasswordRows().forEach(function (cell) {
      if (cell.querySelector(".save-password-direct")) return;
      const button = document.createElement("button");
      button.type = "button";
      button.className = "btn small save-password-direct";
      button.textContent = "Guardar clave";
      button.addEventListener("click", async function () {
        const row = cell.closest("tr");
        const passwordInput = cell.querySelector("input");
        const inputs = row ? Array.from(row.querySelectorAll("input")) : [];
        const emailInput = inputs.find(function (input) { return String(input.value || "").includes("@"); });
        const password = String(passwordInput && passwordInput.value || "").trim();
        const email = String(emailInput && emailInput.value || "").trim().toLowerCase();
        if (!password) return window.alert("Escribe una contrasena antes de guardarla.");
        if (!email) return window.alert("No se pudo identificar el correo del usuario.");
        const originalLabel = button.textContent;
        button.disabled = true;
        button.textContent = "Guardando...";
        try {
          const response = await nativeFetch("/api/user-password", {
            method: "PUT",
            headers: {
              "content-type": "application/json",
              "authorization": "Bearer " + String(sessionStorage.getItem(TOKEN_KEY) || ""),
            },
            body: JSON.stringify({ email: email, password: password }),
          });
          if (!response.ok) throw new Error("D1 rechazo el cambio");
          button.textContent = "Clave guardada";
          button.classList.add("saved");
          window.setTimeout(function () {
            button.textContent = originalLabel;
            button.classList.remove("saved");
          }, 2500);
        } catch (error) {
          console.error(error);
          button.textContent = "Error al guardar";
          window.alert("No se pudo guardar la contrasena en Cloudflare D1.");
          window.setTimeout(function () { button.textContent = originalLabel; }, 2500);
        } finally {
          button.disabled = false;
        }
      });
      cell.appendChild(button);
    });
  }

  const observer = new MutationObserver(installButtons);
  observer.observe(document.documentElement, { childList: true, subtree: true });
  document.addEventListener("DOMContentLoaded", installButtons);
})();

(function () {
  "use strict";

  const TOKEN_KEY = "bpgo-operaciones-auth-token";

  function rowEmail(row) {
    const input = Array.from(row.querySelectorAll("input")).find((item) => String(item.value || "").includes("@"));
    return String(input && input.value || "").trim().toLowerCase();
  }

  function installDeleteButtons() {
    const heading = Array.from(document.querySelectorAll("h1")).find((item) => /administracion operacional/i.test(item.textContent || ""));
    if (!heading) return;
    document.querySelectorAll(".password-cell").forEach(function (cell) {
      const row = cell.closest("tr");
      if (!row || cell.querySelector(".delete-user-direct")) return;
      const button = document.createElement("button");
      button.type = "button";
      button.className = "btn small secondary delete-user-direct";
      button.textContent = "Eliminar usuario";
      button.addEventListener("click", async function () {
        const email = rowEmail(row);
        const nameInput = row.querySelector("input");
        const name = String(nameInput && nameInput.value || email || "este usuario").trim();
        if (!email) return window.alert("No se pudo identificar el correo del usuario.");
        if (!window.confirm(`¿Eliminar definitivamente a ${name}? También se quitarán sus turnos y asignaciones.`)) return;
        button.disabled = true;
        button.textContent = "Eliminando…";
        try {
          const response = await fetch("/api/user", {
            method: "DELETE",
            headers: {
              "content-type": "application/json",
              "authorization": "Bearer " + String(sessionStorage.getItem(TOKEN_KEY) || "")
            },
            body: JSON.stringify({ email: email })
          });
          const result = await response.json().catch(function () { return {}; });
          if (!response.ok) throw new Error(result.error || "No se pudo eliminar el usuario");
          window.alert(`${name} fue eliminado correctamente.`);
          window.location.reload();
        } catch (error) {
          button.disabled = false;
          button.textContent = "Eliminar usuario";
          window.alert(error.message || "No se pudo eliminar el usuario.");
        }
      });
      cell.appendChild(button);
    });
  }

  const observer = new MutationObserver(installDeleteButtons);
  observer.observe(document.documentElement, { childList: true, subtree: true });
  window.addEventListener("DOMContentLoaded", installDeleteButtons);
})();

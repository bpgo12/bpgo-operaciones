(function () {
  "use strict";

  var nativeFetch = window.fetch.bind(window);
  var STATE_PATH = "/api/state";
  var LAST_VERSION_KEY = "bpgo-shared-state-version";
  var checking = false;
  var banner = null;

  function timestamp(value) {
    if (!value) return 0;
    var normalized = String(value).includes("T") ? String(value) : String(value).replace(" ", "T") + "Z";
    return Date.parse(normalized) || 0;
  }

  function knownVersion() {
    return timestamp(sessionStorage.getItem(LAST_VERSION_KEY));
  }

  function remember(value) {
    if (value) sessionStorage.setItem(LAST_VERSION_KEY, String(value));
  }

  function ensureStyles() {
    if (document.getElementById("shared-state-sync-style")) return;
    var style = document.createElement("style");
    style.id = "shared-state-sync-style";
    style.textContent = ".shared-state-banner{position:fixed;z-index:2147483646;right:18px;bottom:18px;max-width:390px;padding:13px 15px;border-radius:12px;background:#102f2b;color:#fff;box-shadow:0 12px 35px rgba(0,0,0,.28);font:600 14px/1.35 system-ui,sans-serif;display:flex;gap:12px;align-items:center}.shared-state-banner.error{background:#8d2626}.shared-state-banner button{border:0;border-radius:8px;padding:8px 11px;background:#fff;color:#123b35;font-weight:800;cursor:pointer;white-space:nowrap}.shared-state-saved{position:fixed;z-index:2147483646;right:18px;bottom:18px;padding:10px 14px;border-radius:10px;background:#087f5b;color:#fff;font:700 14px system-ui,sans-serif;box-shadow:0 10px 28px rgba(0,0,0,.24)}";
    document.head.appendChild(style);
  }

  function showBanner(message, label, action, error) {
    ensureStyles();
    if (banner) banner.remove();
    banner = document.createElement("div");
    banner.className = "shared-state-banner" + (error ? " error" : "");
    var text = document.createElement("span");
    text.textContent = message;
    var button = document.createElement("button");
    button.type = "button";
    button.textContent = label;
    button.addEventListener("click", action);
    banner.append(text, button);
    document.body.appendChild(banner);
  }

  function showSaved() {
    ensureStyles();
    var notice = document.createElement("div");
    notice.className = "shared-state-saved";
    notice.textContent = "Guardado para todos los computadores";
    document.body.appendChild(notice);
    window.setTimeout(function () { notice.remove(); }, 2600);
  }

  function expireSession() {
    localStorage.removeItem("bpgo-operaciones-session");
    sessionStorage.removeItem("bpgo-operaciones-auth-token");
    showBanner("La sesión venció y los cambios no se guardaron.", "Ingresar nuevamente", function () {
      window.location.reload();
    }, true);
  }

  window.fetch = async function synchronizedFetch(input, init) {
    var url = typeof input === "string" ? input : input && input.url;
    var method = String((init && init.method) || (input && input.method) || "GET").toUpperCase();
    var response = await nativeFetch(input, init);
    if (!url || !url.includes(STATE_PATH)) return response;
    if (response.status === 401) {
      expireSession();
      return response;
    }
    var payload = await response.clone().json().catch(function () { return {}; });
    if (response.ok && payload.updatedAt) {
      remember(payload.updatedAt);
      if (method === "PUT") showSaved();
    } else if (!response.ok && method === "PUT") {
      showBanner("Cloudflare no pudo guardar el cambio. Inténtalo nuevamente.", "Cerrar", function () {
        if (banner) banner.remove();
      }, true);
    }
    return response;
  };

  async function checkForUpdates() {
    if (checking || !localStorage.getItem("bpgo-operaciones-session")) return;
    checking = true;
    try {
      var previous = knownVersion();
      var response = await window.fetch(STATE_PATH + "?sync-check=" + Date.now(), { cache: "no-store", credentials: "same-origin" });
      if (!response.ok) return;
      var payload = await response.clone().json().catch(function () { return {}; });
      var remote = timestamp(payload.updatedAt);
      if (!previous) {
        remember(payload.updatedAt);
      } else if (remote > previous) {
        remember(payload.updatedAt);
        if (document.hidden) {
          window.location.reload();
        } else {
          showBanner("Hay cambios nuevos realizados desde otro computador.", "Actualizar", function () {
            window.location.reload();
          }, false);
        }
      }
    } catch (error) {
      console.warn("No se pudo comprobar la sincronización compartida.", error);
    } finally {
      checking = false;
    }
  }

  window.addEventListener("focus", checkForUpdates);
  document.addEventListener("visibilitychange", function () { if (!document.hidden) checkForUpdates(); });
  window.setInterval(checkForUpdates, 20000);
  window.setTimeout(checkForUpdates, 2500);
})();

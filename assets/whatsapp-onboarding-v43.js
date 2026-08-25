(function () {
  "use strict";

  var timer = 0;
  var signupTimeout = 0;
  var onboarding = null;
  var signupResult = {};
  var facebookSdkPromise = null;

  function isApiView() {
    return Array.from(document.querySelectorAll("h2")).some(function (heading) {
      return /api oficial (lista|pendiente)/i.test(heading.textContent || "");
    });
  }

  function escapeHtml(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, function (char) {
      return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char];
    });
  }

  function render(panel, data) {
    onboarding = data;
    var checks = (data.checks || []).map(function (check) {
      return '<li class="' + (check.configured ? "ready" : "pending") + '"><span>' + (check.configured ? "✓" : "○") + '</span><div><strong>' + escapeHtml(check.label) + '</strong><small>' + (check.configured ? "Configurado" : "Pendiente de configurar") + '</small></div></li>';
    }).join("");
    var badge = data.connected ? "Conectado" : data.readyToStart ? "Listo para vincular" : "Configuración pendiente";
    panel.innerHTML = '<header><div><p class="eyebrow">Integración propia BPGO · Meta</p><h3>Coexistencia y registro integrado</h3><p>El negocio ya está verificado. El número continuará en WhatsApp Business y se conectará con operaciones.bpgo.cl mediante el flujo oficial de Meta.</p></div><span class="onboarding-badge ' + (data.connected ? "connected" : "review") + '">' + badge + '</span></header>' +
      '<ul class="onboarding-checks">' + checks + '</ul>' +
      '<div class="onboarding-action"><div><strong>' + (data.connected ? "Integración oficial activa" : data.readyToStart ? "Todo preparado para vincular el número" : "Falta cargar el Config ID de coexistencia") + '</strong><p>' + (data.connected ? "La credencial está cifrada, el webhook quedó suscrito y la plataforma puede recibir y responder mensajes." : "No se modificará el número ni la aplicación móvil hasta iniciar el registro integrado oficial.") + '</p></div>' +
      '<button type="button" class="btn" data-start-embedded-signup ' + (!data.readyToStart || data.connected ? "disabled" : "") + '>' + (data.connected ? "Número conectado" : "Conectar con Meta") + '</button></div>' +
      '<div class="whatsapp-test-status" data-onboarding-status hidden></div>';
  }

  function showStatus(panel, message, kind) {
    var output = panel.querySelector("[data-onboarding-status]");
    output.hidden = false;
    output.className = "whatsapp-test-status " + (kind || "pending");
    output.textContent = message;
  }

  function clearSignupTimeout() {
    window.clearTimeout(signupTimeout);
    signupTimeout = 0;
  }

  function showSignupProgress(panel) {
    if (signupResult.code && (!signupResult.wabaId || !signupResult.phoneNumberId)) {
      showStatus(panel, "Autorización recibida. Completa la selección del número en la ventana de Meta…", "pending");
    } else if (!signupResult.code && signupResult.wabaId && signupResult.phoneNumberId) {
      showStatus(panel, "Número seleccionado. Esperando la autorización final de Meta…", "pending");
    }
  }

  async function loadStatus(panel) {
    panel.innerHTML = '<div class="whatsapp-test-status pending">Revisando preparación técnica…</div>';
    try {
      var response = await fetch("/api/whatsapp/onboarding", { cache: "no-store" });
      var data = await response.json().catch(function () { return {}; });
      if (!response.ok) throw new Error(data.error || "No se pudo revisar la configuración.");
      render(panel, data);
      if (data.readyToStart && !data.connected) {
        loadFacebookSdk(data.appId).catch(function () {});
      }
    } catch (error) {
      panel.innerHTML = '<div class="whatsapp-test-status error">' + escapeHtml(error.message || "No se pudo cargar el registro integrado.") + '</div>';
    }
  }

  function loadFacebookSdk(appId) {
    if (window.FB) return Promise.resolve(window.FB);
    if (facebookSdkPromise) return facebookSdkPromise;
    facebookSdkPromise = new Promise(function (resolve, reject) {
      var settled = false;
      function ready() {
        if (settled || !window.FB) return;
        settled = true;
        window.FB.init({ appId: appId, cookie: true, xfbml: false, version: "v23.0" });
        resolve(window.FB);
      }
      window.fbAsyncInit = function () {
        ready();
      };
      var existing = document.getElementById("facebook-jssdk");
      if (!existing) {
        var script = document.createElement("script");
        script.id = "facebook-jssdk";
        script.async = true;
        script.defer = true;
        script.crossOrigin = "anonymous";
        script.src = "https://connect.facebook.net/es_LA/sdk.js";
        script.onerror = function () {
          facebookSdkPromise = null;
          reject(new Error("No se pudo cargar el acceso seguro de Meta."));
        };
        document.head.appendChild(script);
      }
      var checks = 0;
      var poll = window.setInterval(function () {
        checks += 1;
        if (window.FB) {
          window.clearInterval(poll);
          ready();
        } else if (checks >= 100) {
          window.clearInterval(poll);
          facebookSdkPromise = null;
          reject(new Error("Meta no terminó de cargar. Actualiza la página y vuelve a intentarlo."));
        }
      }, 100);
    });
    return facebookSdkPromise;
  }

  function setStartButton(panel, disabled) {
    var button = panel && panel.querySelector("[data-start-embedded-signup]");
    if (button) button.disabled = Boolean(disabled);
  }
  async function finishSignup(panel, discoverAutomatically) {
    if (!signupResult.code || signupResult.exchangeStarted || signupResult.completed) return;
    if (!signupResult.wabaId || !signupResult.phoneNumberId) return;
    clearSignupTimeout();
    signupResult.exchangeStarted = true;
    signupResult.saving = true;
    showStatus(panel, "Validando la cuenta, suscribiendo el webhook y cifrando las credenciales…", "pending");
    try {
      var response = await fetch("/api/whatsapp/onboarding", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          code: signupResult.code,
          wabaId: signupResult.wabaId || "",
          phoneNumberId: signupResult.phoneNumberId || ""
        })
      });
      var data = await response.json().catch(function () { return {}; });
      if (!response.ok) throw new Error(data.error || "Meta no pudo completar la vinculación.");
      signupResult.completed = true;
      showStatus(panel, "Conexión y recepción de mensajes activadas para " + (data.displayPhoneNumber || "el número BPGO") + ".", "success");
      window.setTimeout(function () { loadStatus(panel); }, 1800);
    } catch (error) {
      signupResult.saving = false;
      signupResult.code = "";
      setStartButton(panel, false);
      showStatus(panel, (error.message || "No se pudo terminar la conexión.") + " Inicia una vinculación nueva para obtener un código válido.", "error");
    }
  }

  async function startSignup(panel) {
    if (!onboarding || !onboarding.readyToStart) return;
    signupResult = {};
    clearSignupTimeout();
    setStartButton(panel, true);
    showStatus(panel, "Abriendo la ventana segura de Meta…", "pending");
    try {
      var FB = await loadFacebookSdk(onboarding.appId);
      FB.login(function (response) {
        if (!response.authResponse || !response.authResponse.code) {
          clearSignupTimeout();
          setStartButton(panel, false);
          showStatus(panel, "La vinculación fue cancelada o Meta no entregó autorización.", "error");
          return;
        }
        signupResult.code = response.authResponse.code;
        showStatus(panel, "Autorización recibida. Esperando la confirmación del número en Meta…", "pending");
        finishSignup(panel);
      }, {
        config_id: onboarding.configId,
        response_type: "code",
        override_default_response_type: true,
        extras: {
          setup: {},
          featureType: "whatsapp_business_app_onboarding",
          sessionInfoVersion: "3"
        }
      });
      signupTimeout = window.setTimeout(function () {
        if (signupResult.saving || signupResult.completed) return;
        var missing = [];
        if (!signupResult.code) missing.push("autorización");
        if (!signupResult.wabaId || !signupResult.phoneNumberId) missing.push("selección del número");
        setStartButton(panel, false);
        showStatus(panel, "Meta no completó " + missing.join(" y ") + ". Presiona nuevamente Conectar con Meta: se abrirá un registro nuevo.", "error");
      }, 45000);
    } catch (error) {
      clearSignupTimeout();
      setStartButton(panel, false);
      showStatus(panel, error.message || "No se pudo abrir Meta.", "error");
    }
  }

  window.addEventListener("message", function (event) {
    var hostname = "";
    try { hostname = new URL(event.origin).hostname; } catch (_) { return; }
    if (hostname !== "facebook.com" && !/\.facebook\.com$/.test(hostname)) return;
    var payload = event.data;
    if (typeof payload === "string") {
      try { payload = JSON.parse(payload); } catch (_) { return; }
    }
    if (!payload || payload.type !== "WA_EMBEDDED_SIGNUP") return;
    if (payload.event === "FINISH" || payload.event === "FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING") {
      var eventData = payload.data && payload.data.data ? payload.data.data : (payload.data || {});
      signupResult.wabaId = String(eventData.waba_id || eventData.wabaId || signupResult.wabaId || "");
      signupResult.phoneNumberId = String(eventData.phone_number_id || eventData.phoneNumberId || signupResult.phoneNumberId || "");
      var panel = document.querySelector("[data-whatsapp-onboarding]");
      if (panel) {
        showSignupProgress(panel);
        finishSignup(panel);
      }
    } else if (payload.event === "CANCEL" || payload.event === "ERROR") {
      clearSignupTimeout();
      var errorPanel = document.querySelector("[data-whatsapp-onboarding]");
      if (errorPanel) {
        setStartButton(errorPanel, false);
        showStatus(errorPanel, "Meta canceló el registro del número. Vuelve a intentarlo y completa todos los pasos de la ventana.", "error");
      }
    }
  });

  function install() {
    document.querySelectorAll("[data-whatsapp-onboarding]").forEach(function (panel) { if (!isApiView()) panel.remove(); });
    if (!isApiView() || document.querySelector("[data-whatsapp-onboarding]")) return;
    var card = Array.from(document.querySelectorAll(".api-readiness-card, .panel")).find(function (element) {
      return /api oficial (lista|pendiente)/i.test(element.textContent || "");
    });
    if (!card) return;
    var panel = document.createElement("section");
    panel.className = "whatsapp-onboarding";
    panel.dataset.whatsappOnboarding = "";
    var testPanel = card.querySelector("[data-whatsapp-test-panel]");
    if (testPanel) card.insertBefore(panel, testPanel); else card.appendChild(panel);
    loadStatus(panel);
  }

  document.addEventListener("click", function (event) {
    var button = event.target.closest("[data-start-embedded-signup]");
    if (button) startSignup(button.closest("[data-whatsapp-onboarding]"));
  });
  function scan() { clearTimeout(timer); timer = window.setTimeout(install, 100); }
  new MutationObserver(scan).observe(document.documentElement, { childList: true, subtree: true });
  document.addEventListener("DOMContentLoaded", install);
  install();
})();


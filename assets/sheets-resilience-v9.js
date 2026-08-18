(function () {
  "use strict";

  const upstreamFetch = window.fetch.bind(window);
  const resilientRoutes = new Map([
    ["/api/business/sheets-workbook", "bpgo-sheets-workbook-v9"],
    ["/api/billing/sheets-sync", "bpgo-sheets-billing-v9"],
  ]);

  function delay(milliseconds) {
    return new Promise(function (resolve) { window.setTimeout(resolve, milliseconds); });
  }

  function cachedResponse(cacheKey) {
    try {
      const cached = localStorage.getItem(cacheKey);
      if (!cached) return null;
      const parsed = JSON.parse(cached);
      if (!parsed || !parsed.payload || Date.now() - parsed.savedAt > 24 * 60 * 60 * 1000) return null;
      return new Response(JSON.stringify(parsed.payload), {
        status: 200,
        headers: {
          "content-type": "application/json; charset=utf-8",
          "x-bpgo-sync-source": "last-successful-sync",
          "cache-control": "no-store",
        },
      });
    } catch {
      return null;
    }
  }

  window.fetch = async function resilientSheetsFetch(input, init) {
    const rawUrl = typeof input === "string" ? input : input && input.url;
    const method = String((init && init.method) || (input && input.method) || "GET").toUpperCase();
    if (!rawUrl || method !== "GET") return upstreamFetch(input, init);

    let pathname;
    try { pathname = new URL(rawUrl, window.location.origin).pathname; } catch { return upstreamFetch(input, init); }
    const cacheKey = resilientRoutes.get(pathname);
    if (!cacheKey) return upstreamFetch(input, init);

    let lastResponse = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const requestUrl = new URL(rawUrl, window.location.origin);
        requestUrl.searchParams.set("sync_attempt", String(Date.now()) + "-" + String(attempt));
        const response = await upstreamFetch(requestUrl.toString(), Object.assign({}, init, { cache: "no-store" }));
        lastResponse = response;
        if (response.ok) {
          const payload = await response.clone().json();
          if (payload && payload.ok) {
            localStorage.setItem(cacheKey, JSON.stringify({ savedAt: Date.now(), payload: payload }));
            return response;
          }
        }
      } catch (error) {
        console.warn("Reintento de sincronizacion Google Sheets", attempt + 1, error);
      }
      if (attempt < 2) await delay(700 * (attempt + 1));
    }

    return cachedResponse(cacheKey) || lastResponse || new Response(JSON.stringify({
      ok: false,
      error: "No se pudo sincronizar Google Sheets despues de varios intentos.",
    }), { status: 503, headers: { "content-type": "application/json" } });
  };
})();

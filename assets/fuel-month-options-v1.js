(() => {
  "use strict";

  const MONTH_FORMATTER = new Intl.DateTimeFormat("es-CL", {
    month: "long",
    year: "numeric",
    timeZone: "America/Santiago",
  });
  const selectedByView = new Map();

  function monthKey(date) {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
  }

  function monthLabel(key) {
    const [year, month] = key.split("-").map(Number);
    return MONTH_FORMATTER.format(new Date(year, month - 1, 1));
  }

  function availableMonths(select) {
    const now = new Date();
    const keys = new Set(Array.from(select.options, (option) => option.value));
    const first = new Date(now.getFullYear(), 0, 1);
    const last = new Date(now.getFullYear() + 2, 11, 1);

    for (const cursor = new Date(first); cursor <= last; cursor.setMonth(cursor.getMonth() + 1)) {
      keys.add(monthKey(cursor));
    }

    return Array.from(keys)
      .filter((key) => /^\d{4}-\d{2}$/.test(key))
      .sort();
  }

  function isFuelMonthSelect(select) {
    const label = select.closest("label");
    const fieldName = label?.querySelector("span")?.textContent?.trim();
    const isFuelPage = Array.from(document.querySelectorAll("h1"))
      .some((heading) => heading.textContent?.trim() === "Control de combustible");
    return isFuelPage && fieldName === "Mes a revisar";
  }

  function enhance(select) {
    if (!isFuelMonthSelect(select)) return;

    const currentMonth = monthKey(new Date());
    const previousValue = selectedByView.get("fuel") || select.value || currentMonth;
    const keys = availableMonths(select);
    const existingKeys = Array.from(select.options, (option) => option.value);

    if (existingKeys.join("|") !== keys.join("|")) {
      const fragment = document.createDocumentFragment();
      for (const key of keys) {
        const option = document.createElement("option");
        option.value = key;
        option.textContent = monthLabel(key);
        fragment.appendChild(option);
      }

      select.replaceChildren(fragment);
    }
    const desiredValue = select.dataset.fuelMonthsReady ? previousValue : currentMonth;
    select.value = keys.includes(desiredValue) ? desiredValue : currentMonth;
    selectedByView.set("fuel", select.value);

    if (!select.dataset.fuelMonthsReady) {
      select.dataset.fuelMonthsReady = "true";
      select.addEventListener("change", () => selectedByView.set("fuel", select.value));
      select.dispatchEvent(new Event("change", { bubbles: true }));
    }
  }

  function refresh() {
    document.querySelectorAll("select").forEach(enhance);
  }

  const observer = new MutationObserver(() => requestAnimationFrame(refresh));
  observer.observe(document.documentElement, { childList: true, subtree: true });
  document.addEventListener("DOMContentLoaded", refresh);
})();

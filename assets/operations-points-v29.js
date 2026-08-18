(function () {
  "use strict";

  const CLOSED = new Set(["finalizado", "finalizada", "completada", "completado", "cerrada", "cerrado"]);
  const RESCHEDULED = new Set(["reagendada", "reagendado", "reprogramada", "reprogramado", "requiere nueva visita"]);
  const normalize = (value) => String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
  const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" })[character]);
  const dateKey = (date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  const parseDate = (value) => {
    if (!value) return null;
    const date = new Date(String(value).length === 10 ? `${value}T12:00:00` : value);
    return Number.isNaN(date.getTime()) ? null : date;
  };

  function unwrapState(payload) {
    let value = payload;
    for (let depth = 0; depth < 5; depth += 1) {
      if (typeof value === "string") {
        try { value = JSON.parse(value); continue; } catch { return {}; }
      }
      if (!value || typeof value !== "object") return {};
      if (Array.isArray(value.workOrders)) return value;
      if (value.data !== undefined) { value = value.data; continue; }
      if (value.state !== undefined) { value = value.state; continue; }
      if (value.payload !== undefined) { value = value.payload; continue; }
      break;
    }
    return value || {};
  }

  function workText(work) {
    return normalize([work.type, work.title, work.description, work.serviceType, work.category].filter(Boolean).join(" "));
  }

  function classification(work) {
    const text = workText(work);
    if (text.includes("instalacion")) return "installation";
    if (text.includes("mantencion") || text.includes("mantenimiento")) return "maintenance";
    return "other";
  }

  function isBpgoMaintenance(work) {
    if (classification(work) !== "maintenance") return false;
    const client = normalize([work.client, work.customerName, work.customer, work.accountName].filter(Boolean).join(" "));
    return /(^|\s)bpgo($|\s)/.test(client);
  }

  function isClosed(work) { return CLOSED.has(normalize(work.status)); }
  function isRescheduled(work) { return RESCHEDULED.has(normalize(work.status)) || Boolean(work.rescheduleRequestedDate); }
  function hasEvidence(work) { return Array.isArray(work.logs) && work.logs.some((log) => Array.isArray(log.evidence) && log.evidence.length); }

  function closeDate(work) {
    const logs = Array.isArray(work.logs) ? work.logs : [];
    const finalLog = logs.find((log) => CLOSED.has(normalize(log.status))) || logs[0];
    return parseDate(finalLog && finalLog.createdAt) || parseDate(work.completedAt) || parseDate(work.closedAt) || parseDate(work.updatedAt) || parseDate(work.plannedDate || work.dueDate);
  }

  function assignedIds(work) {
    return [...new Set([...(Array.isArray(work.assignedToIds) ? work.assignedToIds : []), work.assignedToId, work.technicianId].filter(Boolean))];
  }

  function selectedPeriod(root) {
    const active = [...root.querySelectorAll(".segmented button")].find((button) => button.classList.contains("active"));
    const mode = normalize(active && active.textContent) || "semana";
    const today = new Date();
    let start = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    let end = new Date(start);
    let label = "Hoy";
    if (mode.includes("mes")) {
      start = new Date(today.getFullYear(), today.getMonth(), 1);
      end = new Date(today.getFullYear(), today.getMonth() + 1, 0);
      label = new Intl.DateTimeFormat("es-CL", { month: "long", year: "numeric" }).format(today);
    } else if (mode.includes("sem")) {
      const offset = (today.getDay() + 6) % 7;
      start.setDate(today.getDate() - offset);
      end = new Date(start);
      end.setDate(start.getDate() + 6);
      label = "Semana actual";
    }
    end.setHours(23, 59, 59, 999);
    return { start, end, label };
  }

  function inRange(value, range) {
    const date = value instanceof Date ? value : parseDate(value);
    return Boolean(date && date >= range.start && date <= range.end);
  }

  function technicianName(id, users) {
    const user = users.find((item) => String(item.id) === String(id));
    return user ? user.name : "Sin asignar";
  }

  function activityLabel(work) {
    const kind = classification(work);
    return kind === "installation" ? "Instalación" : kind === "maintenance" ? "Mantención" : (work.type || work.title || "Otra actividad");
  }

  function formatDate(value) {
    const date = value instanceof Date ? value : parseDate(value);
    return date ? new Intl.DateTimeFormat("es-CL").format(date) : "Sin fecha";
  }

  function calculate(state, range) {
    const allWork = Array.isArray(state.workOrders) ? state.workOrders : [];
    const users = Array.isArray(state.users) ? state.users : [];
    const periodWork = allWork.filter((work) => inRange(work.plannedDate || work.dueDate, range));
    const closedInPeriod = allWork.filter((work) => isClosed(work) && inRange(closeDate(work), range));
    const technicians = users.filter((user) => user.role === "technician" || assignedIds({ assignedToIds: allWork.flatMap(assignedIds) }).includes(user.id));
    const technicianIds = new Set(allWork.flatMap(assignedIds).map(String));
    users.forEach((user) => { if (technicianIds.has(String(user.id)) && !technicians.includes(user)) technicians.push(user); });

    const rows = technicians.map((user) => {
      const assigned = periodWork.filter((work) => assignedIds(work).some((id) => String(id) === String(user.id)));
      const closed = closedInPeriod.filter((work) => assignedIds(work).some((id) => String(id) === String(user.id)));
      const installations = closed.filter((work) => classification(work) === "installation");
      const bpgoMaintenances = closed.filter(isBpgoMaintenance);
      const maintenances = closed.filter((work) => classification(work) === "maintenance");
      const other = closed.filter((work) => classification(work) === "other");
      const rescheduled = assigned.filter(isRescheduled);
      return {
        id: user.id, name: user.name, assigned: assigned.length, closed: closed.length,
        installations: installations.length, maintenances: maintenances.length,
        bpgoMaintenances: bpgoMaintenances.length, other: other.length,
        rescheduled: rescheduled.length, missingEvidence: assigned.filter((work) => !hasEvidence(work)).length,
        installationPoints: installations.length, maintenancePoints: bpgoMaintenances.length,
        points: installations.length + bpgoMaintenances.length,
        rate: assigned.length ? Math.round((closed.length / assigned.length) * 100) : 0
      };
    }).sort((a, b) => b.points - a.points || b.closed - a.closed || b.assigned - a.assigned);

    return { allWork, users, periodWork, closedInPeriod, rows };
  }

  function card(title, value, detail, tone) {
    return `<article class="bpgo-point-card ${tone || ""}"><span>${escapeHtml(title)}</span><strong>${escapeHtml(value)}</strong><small>${escapeHtml(detail)}</small></article>`;
  }

  function render(container, state, range) {
    const data = calculate(state, range);
    const installations = data.closedInPeriod.filter((work) => classification(work) === "installation");
    const maintenances = data.closedInPeriod.filter((work) => classification(work) === "maintenance");
    const bpgoMaintenances = maintenances.filter(isBpgoMaintenance);
    const otherClosed = data.closedInPeriod.filter((work) => classification(work) === "other");
    const rescheduled = data.periodWork.filter(isRescheduled);
    const pending = data.periodWork.filter((work) => !isClosed(work) && normalize(work.status) !== "cancelada");
    const totalPoints = installations.length + bpgoMaintenances.length;
    const completion = data.periodWork.length ? Math.round((data.periodWork.filter(isClosed).length / data.periodWork.length) * 100) : 0;

    const details = data.closedInPeriod.slice().sort((a, b) => (closeDate(b)?.getTime() || 0) - (closeDate(a)?.getTime() || 0));
    const detailRows = details.map((work) => {
      const kind = classification(work);
      const point = kind === "installation" || isBpgoMaintenance(work) ? 1 : 0;
      const names = assignedIds(work).map((id) => technicianName(id, data.users)).join(", ") || "Sin asignar";
      const reason = point ? (kind === "installation" ? "Instalación cerrada" : "Mantención BPGO cerrada") : "Actividad cerrada sin puntaje";
      return `<tr><td><strong>${escapeHtml(work.code || "Sin código")}</strong><small>${escapeHtml(work.client || "Sin cliente")}</small></td><td>${escapeHtml(activityLabel(work))}</td><td>${escapeHtml(names)}</td><td>${escapeHtml(formatDate(closeDate(work)))}</td><td><span class="bpgo-points-pill ${point ? "earned" : "zero"}">${point} pt</span><small>${escapeHtml(reason)}</small></td></tr>`;
    }).join("");

    const techCards = data.rows.map((row) => `<article class="bpgo-tech-card"><header><div><span>Técnico</span><h3>${escapeHtml(row.name)}</h3></div><strong>${row.points} pts</strong></header><div class="bpgo-tech-metrics"><span><b>${row.installations}</b> instalaciones</span><span><b>${row.bpgoMaintenances}</b> mant. BPGO</span><span><b>${row.maintenances}</b> mant. totales</span><span><b>${row.rescheduled}</b> reagendadas</span><span><b>${row.closed}</b> finalizadas</span><span><b>${row.rate}%</b> avance</span></div></article>`).join("");

    const techRows = data.rows.map((row) => `<tr><td><strong>${escapeHtml(row.name)}</strong></td><td>${row.assigned}</td><td>${row.closed}</td><td>${row.installations}</td><td>${row.maintenances}</td><td>${row.bpgoMaintenances}</td><td>${row.other}</td><td>${row.rescheduled}</td><td>${row.missingEvidence}</td><td>${row.installationPoints}</td><td>${row.maintenancePoints}</td><td><strong class="bpgo-total-points">${row.points}</strong></td><td>${row.rate}%</td></tr>`).join("");

    container.innerHTML = `
      <section class="bpgo-points-hero"><div><span class="eyebrow">Productividad y bonos · ${escapeHtml(range.label)}</span><h2>Puntos validados por cierre</h2><p>1 punto por instalación cerrada y 1 punto por mantención cerrada cuyo cliente sea BPGO. Las actividades abiertas no generan puntaje.</p></div><div class="bpgo-points-total"><span>Total periodo</span><strong>${totalPoints}</strong><small>puntos validados</small></div></section>
      <section class="bpgo-point-grid">
        ${card("Actividades del periodo", data.periodWork.length, `${data.closedInPeriod.length} cierres registrados`, "")}
        ${card("Instalaciones finalizadas", installations.length, `${installations.length} puntos de instalación`, "blue")}
        ${card("Mantenciones finalizadas", maintenances.length, `${bpgoMaintenances.length} corresponden a BPGO`, "orange")}
        ${card("Puntos mantención BPGO", bpgoMaintenances.length, "Solo cerradas y cliente BPGO", "purple")}
        ${card("Total puntos", totalPoints, "Instalaciones + mantenciones BPGO", "green")}
        ${card("Reagendadas", rescheduled.length, `${pending.length} actividades aún abiertas`, "red")}
        ${card("Avance operativo", `${completion}%`, `${data.periodWork.filter(isClosed).length} cerradas de ${data.periodWork.length}`, "")}
        ${card("Otros cierres", otherClosed.length, "Finalizados sin puntaje", "")}
      </section>
      <section class="bpgo-analysis-panel"><div class="bpgo-section-head"><div><h2>Productividad detallada por técnico</h2><p>El puntaje se asigna individualmente a cada técnico responsable de una actividad válida.</p></div><span class="bpgo-rule-badge">Regla: cierre obligatorio</span></div><div class="bpgo-tech-grid">${techCards || '<div class="empty">Sin técnicos con actividad en el periodo.</div>'}</div></section>
      <section class="bpgo-analysis-panel"><div class="bpgo-section-head"><div><h2>Resumen completo por técnico</h2><p>Asignaciones, tipos de cierre, incidencias operativas y puntos para liquidación mensual.</p></div></div><div class="bpgo-table-wrap"><table class="bpgo-analysis-table"><thead><tr><th>Técnico</th><th>Asignadas</th><th>Finalizadas</th><th>Instal.</th><th>Mant.</th><th>Mant. BPGO</th><th>Otras</th><th>Reagend.</th><th>Sin evidencia</th><th>Pts. instal.</th><th>Pts. mant.</th><th>Total pts.</th><th>Avance</th></tr></thead><tbody>${techRows || '<tr><td colspan="13">Sin técnicos registrados.</td></tr>'}</tbody></table></div></section>
      <section class="bpgo-analysis-panel"><div class="bpgo-section-head"><div><h2>Actividades finalizadas del periodo</h2><p>Detalle auditable de qué se cerró, quién lo realizó y por qué obtuvo —o no— puntaje.</p></div><span class="bpgo-rule-badge">${details.length} cierres</span></div><div class="bpgo-table-wrap"><table class="bpgo-analysis-table bpgo-detail-table"><thead><tr><th>Orden / cliente</th><th>Actividad</th><th>Técnico(s)</th><th>Fecha cierre</th><th>Puntaje</th></tr></thead><tbody>${detailRows || '<tr><td colspan="5">No hay actividades finalizadas en este periodo.</td></tr>'}</tbody></table></div></section>
      <section class="bpgo-method-panel"><h3>Criterio automático de puntaje</h3><ul><li><strong>Instalación:</strong> 1 punto al quedar cerrada.</li><li><strong>Mantención BPGO:</strong> 1 punto al quedar cerrada y tener BPGO como cliente.</li><li><strong>Otras actividades:</strong> se informan en el análisis, pero no suman puntos.</li><li><strong>Reagendadas o abiertas:</strong> no generan puntos hasta su cierre definitivo.</li></ul></section>`;
  }

  let statePromise;
  function loadState() {
    if (!statePromise) statePromise = fetch("/api/state", { cache: "no-store", credentials: "same-origin" }).then((response) => {
      if (!response.ok) throw new Error(`Estado HTTP ${response.status}`);
      return response.json();
    }).then(unwrapState);
    return statePromise;
  }

  async function mount() {
    const heading = [...document.querySelectorAll("h1")].find((element) => normalize(element.textContent).includes("control operativo de tecnicos"));
    if (!heading) return;
    const topbar = heading.closest(".topbar") || heading.parentElement;
    const parent = topbar && topbar.parentElement;
    if (!parent || parent.querySelector("#bpgo-points-dashboard")) return;
    const container = document.createElement("div");
    container.id = "bpgo-points-dashboard";
    container.innerHTML = '<section class="bpgo-analysis-panel"><p>Cargando análisis de productividad y puntos…</p></section>';
    topbar.insertAdjacentElement("afterend", container);
    [...parent.children].forEach((child) => { if (child !== topbar && child !== container) child.classList.add("bpgo-original-dashboard-hidden"); });
    try {
      const state = await loadState();
      render(container, state, selectedPeriod(topbar));
      topbar.querySelectorAll(".segmented button").forEach((button) => button.addEventListener("click", () => window.setTimeout(() => render(container, state, selectedPeriod(topbar)), 40)));
    } catch (error) {
      container.innerHTML = `<section class="bpgo-analysis-panel bpgo-load-error"><h2>No se pudo cargar el análisis</h2><p>${escapeHtml(error.message)}</p><button type="button" class="btn" onclick="location.reload()">Reintentar</button></section>`;
    }
  }

  const observer = new MutationObserver(mount);
  observer.observe(document.documentElement, { childList: true, subtree: true });
  window.addEventListener("DOMContentLoaded", mount);
  window.addEventListener("focus", () => { statePromise = null; mount(); });
})();

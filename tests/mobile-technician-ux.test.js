const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const css = fs.readFileSync(path.join(root, "assets", "mobile-v5.css"), "utf8");
const js = fs.readFileSync(path.join(root, "assets", "mobile-ux-v11.js"), "utf8");
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

assert(js.includes('role.includes("tecnico")'), "La vista debe reconocer la sesión de técnico.");
assert(css.includes("body.mobile-technician .work-card-compact .compact-description"), "La descripción debe ser visible en móvil.");
assert(css.includes('-webkit-line-clamp: 3'), "La descripción debe mantenerse compacta.");
assert(css.includes('content: "Abrir actividad"'), "Cada tarjeta debe tener una acción clara.");
assert(css.includes("env(safe-area-inset-bottom)"), "La interfaz debe respetar el área segura de iPhone.");
assert(html.includes("/assets/mobile-ux-v11.js?v=13"), "Debe cargarse la lógica móvil actualizada.");
assert(html.includes("/assets/mobile-v5.css?v=16"), "Debe cargarse el estilo móvil actualizado.");

console.log("mobile technician UX tests: ok");

// 2026-10-15 (Carlos): agenda, detalle de actividad y agenda móvil muestran las Observaciones del cliente
// (accessNotes), nunca la descripción de plantilla del tipo de trabajo.
{
  const fs = require("node:fs");
  const path = require("node:path");
  const assert = require("node:assert/strict");
  const agenda = fs.readFileSync(path.join(__dirname, "..", "assets", "agenda-integrated-v35.js"), "utf8");
  const mobile = fs.readFileSync(path.join(__dirname, "..", "assets", "mobile-agenda-calendar-v1.js"), "utf8");
  // work.description sigue sirviendo solo para el buscador (searchText), no se muestra.
  assert.doesNotMatch(agenda, /"Descripción: "/);
  assert.doesNotMatch(agenda, /Descripción del trabajo/);
  assert.match(agenda, /<strong>Observaciones<\/strong>/);
  assert.match(agenda, /"Observaciones: " \+ description/);
  assert.doesNotMatch(mobile, /work\.description/);
  assert.match(mobile, /Observaciones: '/);
}

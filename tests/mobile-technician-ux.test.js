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

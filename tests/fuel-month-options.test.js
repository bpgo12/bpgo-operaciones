const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const bundle = fs.readFileSync(path.join(root, "assets", "index-bulk-v28.js"), "utf8");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

// Caso real 2026-11-10: los meses generados salían como "AAAA-MM" y el formato del selector es "MM-AAAA": aparecían "octubre de 2069...2078".
assert(bundle.includes("t.add(`${String(n.getMonth()+1).padStart(2,`0`)}-${n.getFullYear()}`)"), "Los meses generados deben usar el formato MM-AAAA, igual que los de la planilla.");
assert(!bundle.includes("t.add(`${n.getFullYear()}-${String(n.getMonth()+1)"), "No debe quedar el formato AAAA-MM en el selector.");
assert(bundle.includes("e.getFullYear()+2,11,1"), "El selector debe generar meses futuros dinámicamente.");
assert(bundle.includes("M.map(e=>(0,Q.jsx)(`option`,{value:e,children:I6(e)},e))"), "Las opciones deben pertenecer al selector React real.");
assert(bundle.includes("_=o||g,y=h.find(e=>e.month===_)"), "Las métricas deben depender del mes seleccionado.");

console.log("fuel month options tests: ok");

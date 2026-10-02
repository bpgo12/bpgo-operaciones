const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const asset = fs.readFileSync(path.join(root, "assets", "fuel-month-options-v1.js"), "utf8");
const index = fs.readFileSync(path.join(root, "index.html"), "utf8");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

assert(asset.includes("now.getFullYear() + 2"), "El selector debe generar meses futuros dinámicamente.");
assert(asset.includes('heading.textContent?.trim() === "Control de combustible"'), "El cambio debe limitarse a Combustible.");
assert(asset.includes('select.dispatchEvent(new Event("change"'), "El mes actual debe sincronizarse con React.");
assert(index.includes("/assets/fuel-month-options-v1.js?v=1"), "El parche debe cargarse desde index.html.");

console.log("fuel month options tests: ok");

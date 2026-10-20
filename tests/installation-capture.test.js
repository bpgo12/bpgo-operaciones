// Captura de datos de instalación (classifyInstallationFragment) con mensajes reales de clientes.
// Se ejecuta la función real del _worker.js en un contexto aislado.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const src = fs.readFileSync(path.join(__dirname, "..", "_worker.js"), "utf8");
function fn(name) {
  const start = src.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `missing ${name}`);
  let depth = 0;
  let i = src.indexOf("{", start);
  for (; i < src.length; i += 1) {
    if (src[i] === "{") depth += 1;
    else if (src[i] === "}") { depth -= 1; if (depth === 0) break; }
  }
  return src.slice(start, i + 1);
}
const patternStart = src.indexOf("const INSTALLATION_LABEL_PATTERN =");
assert.notEqual(patternStart, -1, "missing INSTALLATION_LABEL_PATTERN");
const code = [src.slice(patternStart, src.indexOf("/i;", patternStart) + 3), fn("installationLabelField"),
  fn("normalizeInstallationPhone"), fn("isNameLikeFragment"), fn("isLikelyNotAName"), fn("classifyInstallationFragment")].join("\n");
const context = {};
vm.runInNewContext(code, context);
const parse = (text, current = {}) => context.classifyInstallationFragment(text, current);

const ivan = { name: "Ivan Lagos Mena", rut: "10079190-0", phone: "912000025", email: "cliente3@ejemplo.cl", address: "Valle Verde , Cayucupil" };
// Caso real 2026-10-20 (56912000025): datos uno por línea sin etiquetas; el teléfono con espacios terminaba como dirección.
assert.deepEqual({ ...parse("Ivan Lagos Mena\n10079190-0\n9 1200 0025\ncliente3@ejemplo.cl\nValle Verde , Cayucupil") }, ivan);
// Mismo cliente, mensaje editado: etiquetas solas en su línea (con y sin dos puntos) y el dato en la línea siguiente.
assert.deepEqual({ ...parse("Nombre:Ivan Lagos Mena\nRut:\n10079190-0\nTelefono\n9 1200 0025\nCorreo:\ncliente3@ejemplo.cl\nDirección\nValle Verde , Cayucupil") }, ivan);
// Teléfono suelto con espacios, guiones o +56: es teléfono, nunca dirección.
assert.deepEqual({ ...parse("9 1200 0025", { name: "Ivan Lagos Mena", address: "Valle Verde" }) }, { phone: "912000025" });
assert.deepEqual({ ...parse("+56 9 1200-0025", { name: "X Y" }) }, { phone: "+56912000025" });
// Formulario completo con dos puntos en la misma línea.
assert.deepEqual({ ...parse("Nombre del titular: Ana Pérez Soto\nRut: 12.345.678-5\nNúmero de teléfono: 912345678\nCorreo: ana@mail.cl\nDirección: Camino a Peleco km 5, casa azul") },
  { name: "Ana Pérez Soto", rut: "12.345.678-5", phone: "912345678", email: "ana@mail.cl", address: "Camino a Peleco km 5, casa azul" });
// RUT sin dígito verificador (caso 2026-10-20, 56912000014) sigue siendo RUT.
assert.deepEqual({ ...parse("12345678", { name: "Ana Torres" }) }, { rut: "12345678" });
// Preguntas y frases sueltas no son datos.
assert.equal(parse("¿Cuánto demora la instalación?", { name: "Ana Pérez" }), null);
assert.equal(parse("Necesito conexión", { name: "Ivan Lagos Mena" }), null);
// Nombres que empiezan como una etiqueta no se confunden.
assert.deepEqual({ ...parse("Mailén Soto Rivas") }, { name: "Mailén Soto Rivas" });
assert.deepEqual({ ...parse("Rutilio Pérez Mora") }, { name: "Rutilio Pérez Mora" });

// Una edición de mensaje (sin texto) no se contesta: respondía "Gracias por la foto".
assert.match(src, /if \(\["edit", "revoke", "unsupported", "system", "ephemeral", "deleted"\]\.includes\(message\.type\)\) continue;/);
console.log("installation capture: ok");

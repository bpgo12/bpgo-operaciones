// Captura de datos de instalación: conversaciones reales (2026-09/10) reproducidas con DATOS INVENTADOS pero la MISMA forma
// (orden, etiquetas, errores de tipeo, espacios, charla posterior). El repositorio es público: nunca poner datos reales aquí.
// Se ejecuta el lector real del _worker.js, mensaje a mensaje como el bot (cada dato reemplaza al anterior; con los 5 datos
// la captura termina). Si un caso nuevo falla en producción, agregarlo aquí con datos inventados.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const src = fs.readFileSync(path.join(__dirname, "..", "_worker.js"), "utf8");
function block(startToken) {
  const start = src.indexOf(startToken);
  assert.notEqual(start, -1, `missing ${startToken}`);
  let depth = 0;
  if (startToken.startsWith("const ")) {
    for (let i = start; i < src.length; i += 1) {
      const c = src[i];
      if ("[({".includes(c)) depth += 1;
      else if ("])}".includes(c)) depth -= 1;
      else if (c === ";" && depth === 0) return src.slice(start, i + 1);
    }
  }
  let i = src.indexOf("{", start);
  for (; i < src.length; i += 1) {
    if (src[i] === "{") depth += 1;
    else if (src[i] === "}") { depth -= 1; if (depth === 0) break; }
  }
  return src.slice(start, i + 1);
}
const context = {};
vm.runInNewContext([
  "const INSTALLATION_SECTORS =", "const INSTALLATION_ADDRESS_WORDS =", "const INSTALLATION_CHAT_WORDS =",
  "const INSTALLATION_NAME_STOPWORDS =", "const INSTALLATION_LABELS =", "const INSTALLATION_COMMON_WORDS =",
  "const INSTALLATION_NAME_PARTICLES =", "function installationPlain(", "function installationRutCheckDigit(", "function normalizeInstallationRut(",
  "function normalizeInstallationPhone(", "function isInstallationName(", "function isInstallationAddress(",
  "function classifyInstallationFragment(",
].map(block).join("\n") + "\nthis.parse = classifyInstallationFragment;", context);

// Conversación como la procesa el bot.
function capture(messages) {
  const lead = { name: null, rut: null, phone: null, email: null, address: null };
  for (const text of messages) {
    if (Object.values(lead).every(Boolean)) break;
    const fragment = context.parse(text, { name: lead.name, address: lead.address });
    if (fragment) Object.assign(lead, fragment);
  }
  return lead;
}
const check = (title, messages, expected) => assert.deepEqual(capture(messages), { name: null, rut: null, phone: null, email: null, address: null, ...expected }, title);

// 1. Etiquetas con tipeo ("Hombre:"), "Número:" con +56 y línea del plan al final.
check("etiquetas con tipeo y plan", ["Hombre:Ana Torres Vidal \nRut:17.111.222-3\nNúmero:+56911112222\nCorreo: ana.t@mail.cl \nDirección:puente lanalhue \nplan:$18.000"],
  { name: "Ana Torres Vidal", rut: "17111222-3", phone: "+56911112222", email: "ana.t@mail.cl", address: "puente lanalhue" });
// 2. Datos de a poco, con charla entre medio y RUT de 9 dígitos sin guion.
check("datos de a poco con charla", ["Nombre: Rosa Pinto \n922223333\nRosapinto@mail.cl", "Oka,no ahi problema", "Ah me falta dirección \nLanalhue hijuela nro 8", "Plan  30 NV", "El 18 mil", "152223334"],
  { name: "Rosa Pinto", rut: "15222333-4", phone: "922223333", email: "rosapinto@mail.cl", address: "Lanalhue hijuela nro 8" });
// 3. Todo en una línea separado por columnas de espacios.
check("todo en una línea", ["KARLA RIOS 16.333.444-5     933334444             KR915@MAIL.ES          PLAN PALTINO"],
  { name: "KARLA RIOS", rut: "16333444-5", phone: "933334444", email: "kr915@mail.es" });
// 4. RUT con espacio en vez de guion y teléfono en frase.
check("rut con espacio", ["Pedro Alberto Soto Mena rut 5444555 6", "Numero de teléfono es 944445555\nÉl plan de 18 mil pesos ya"],
  { name: "Pedro Alberto Soto Mena", rut: "5444555-6", phone: "944445555" });
// 5. Todo en una línea con "/" y etiquetas a mitad de línea.
check("etiquetas a mitad de línea", ["Luis Mora fuentes, 14.555.666-7 /correo electrónico: luism@mail.cl dirección fdo.anique lote B", "Número telefónico 955556666"],
  { name: "Luis Mora fuentes", rut: "14555666-7", phone: "955556666", email: "luism@mail.cl", address: "fdo.anique lote B" });
// 6. RUT con "_", "número de contacto" después del teléfono, "Dirección" sin dos puntos y "Correo no tengo".
check("sin correo", ["Queremos contratar Internet, Tomas Rojas", "Tomas Rojas Campos                              rut 7666777_8                  966667777  número de contacto",
  "Dirección lanalhue camino a internado", "Correo no tengo"],
  { name: "Tomas Rojas Campos", rut: "7666777-8", phone: "966667777", email: "sin correo", address: "lanalhue camino a internado" });
// 7. Caso 2026-10-20: uno por línea sin etiquetas, teléfono con espacios, dirección con coma.
check("uno por línea con teléfono con espacios", ["Ivan Lagos Mena \n10777888-9 \n9 7777 8888 \nIvan_l@mail.com \nValle Verde , Cayucupil"],
  { name: "Ivan Lagos Mena", rut: "10777888-9", phone: "977778888", email: "ivan_l@mail.com", address: "Valle Verde , Cayucupil" });
// 8. Mismo caso editado: etiquetas solas en su línea, con y sin dos puntos.
check("etiquetas solas en su línea", ["Nombre:Ivan Lagos Mena\nRut:\n10777888-9\nTelefono\n9 7777 8888\nCorreo:\nIvan_l@mail.com\nDirección\nValle Verde , Cayucupil"],
  { name: "Ivan Lagos Mena", rut: "10777888-9", phone: "977778888", email: "ivan_l@mail.com", address: "Valle Verde , Cayucupil" });
// 9. La charla después de la dirección NO se pega a la dirección.
check("datos completos uno por mensaje", ["Mario Pino Torres", "15888999-k", "+569 88889999", "Mario.p@mail.cl", "Fundo anique pasaje 6 S/n"],
  { name: "Mario Pino Torres", rut: "15888999-K", phone: "+56988889999", email: "mario.p@mail.cl", address: "Fundo anique pasaje 6 S/n" });
check("charla sin completar", ["Mario Pino Torres", "Fundo anique pasaje 6 S/n", "Plan diamante 500 mb", "Exelente", "Los espero", "Disculpen la hora", "Okey", "Bueno"],
  { name: "Mario Pino Torres", address: "Fundo anique pasaje 6 S/n" });
// 10. Preguntas y frases no son nombre ni dirección.
check("preguntas no son datos", ["Esos planes vienen con TV igual ?", "Me puedes dar más información", "Por favor", "Buen dia", "Con la cuenta rut", "Después de las 2", "Se lo envie dos veces ya"], {});
check("pregunta con sector no es dirección", ["UD. Es la misma persona que está escribiendo en el grupo de lanalhue, verdad", "Juan Paz \n11999000-1\n+56990001111\njpaz@mail.cl \nParcela 11 Hijuela 1 lanalhue"],
  { name: "Juan Paz", rut: "11999000-1", phone: "+56990001111", email: "jpaz@mail.cl", address: "Parcela 11 Hijuela 1 lanalhue" });
// 11. "sin número" se conserva en la dirección; "Nr:" es teléfono; RUT con tipeo de un dígito extra.
check("parcela sin número", ["Diego Cortes Rivera", "Rut:10111222-3", "+56 911122233", "Parcela 28 sin número ,. Peleco"],
  { name: "Diego Cortes Rivera", rut: "10111222-3", phone: "+56911122233", address: "Parcela 28 sin número ,. Peleco" });
check("Nr y rut con tipeo", ["Si", "Nombre : Pablo Luengo Rios", "Nr: 912312312", "Correo: pablo.l@mail.cl", "Rut:128.111.222-3", "Uno de 5 equipo", "El de 18"],
  { name: "Pablo Luengo Rios", rut: "128111222-3", phone: "912312312", email: "pablo.l@mail.cl" });
// 12. Nombre dentro de una frase que empieza con "Que"; RUT pegado de 8 dígitos con verificador válido (8.123.456-6).
check("nombre en frase", ["81234566", "Que honda si ya le di el numbre de la titular que quiere instalar aca en peleco que es marta Soto Rivas"],
  { name: "marta Soto Rivas", rut: "8123456-6" });
// RUT pegado de 8 dígitos cuyo último dígito NO es un verificador válido: es el RUT sin verificador y se deja tal cual.
check("rut sin verificador", ["12345678"], { rut: "12345678" });
// 13. Nombre partido en dos líneas del mismo mensaje.
check("nombre en dos líneas", ["Ana Beatriz\n López Rodríguez \n\nRUT 12345678-9\nCelular 963000111\nanabl@mail.cl \nVillorrio lanalhue sitio 1\nPlan 30mb"],
  { name: "Ana Beatriz López Rodríguez", rut: "12345678-9", phone: "963000111", email: "anabl@mail.cl", address: "Villorrio lanalhue sitio 1" });
// 14. Nombres que se parecen a etiquetas o llevan partículas; sector solo como dirección.
check("nombre Mailén", ["Mailén Soto Rivas"], { name: "Mailén Soto Rivas" });
check("nombre Rutilio", ["Rutilio Pérez Mora"], { name: "Rutilio Pérez Mora" });
check("nombre con De La", ["Clotilde de la Fuente Mora"], { name: "Clotilde de la Fuente Mora" });
check("solo sector", ["Jose Pardo", "Tres sauces"], { name: "Jose Pardo", address: "Tres sauces" });
// 15. Referencia de ubicación con dos espacios por tipeo (no se parte en columnas).
check("referencia de ubicación", ["Tomas Rojas", "A un kilómetros más menos del  puente acá a mi casa"], { name: "Tomas Rojas", address: "A un kilómetros más menos del puente acá a mi casa" });

// Una edición de mensaje (sin texto) no se contesta: respondía "Gracias por la foto".
assert.match(src, /if \(\["edit", "revoke", "unsupported", "system", "ephemeral", "deleted"\]\.includes\(message\.type\)\) continue;/);
console.log("installation capture: ok");

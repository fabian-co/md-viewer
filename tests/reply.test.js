// Pruebas del análisis de respuestas del chat (src/ai.js): node tests/reply.test.js
// Extrae del código real parseReply y wrapLooseContent para probarlas sin la interfaz.
const fs = require("fs");
const src = fs.readFileSync(require("path").join(__dirname, "../src/ai.js"), "utf8");

const between = (a, b) => {
  const i = src.indexOf(a), j = src.indexOf(b, i);
  if (i < 0 || j < 0) throw new Error(`No se encontró ${a}`);
  return src.slice(i, j);
};
const code = [
  between("  const OPEN_RE", "  // Busca `search`"),
  between("  function wrapLooseContent", "  // Texto de la respuesta sin los bloques"),
  "return { parseReply, wrapLooseContent };",
].join("\n");
const { parseReply, wrapLooseContent } = new Function(code)();

let fails = 0;
function check(name, cond, extra = "") {
  if (!cond) { fails++; console.log(`FALLA  ${name} ${extra}`); }
  else console.log(`ok     ${name}`);
}
const edits = (text) => parseReply(text, false).filter((p) => p.type === "edit");

// 1. Bloques bien formados
let e = edits("Añado el párrafo.\n\n<<<<<<< AL FINAL\nNuevo párrafo.\n>>>>>>> FIN");
check("AL FINAL correcto", e.length === 1 && e[0].kind === "append" && e[0].replace === "Nuevo párrafo.");
e = edits("<<<<<<< BUSCAR\nhola\n=======\nadiós\n>>>>>>> REEMPLAZAR");
check("BUSCAR/REEMPLAZAR", e.length === 1 && e[0].search === "hola" && e[0].replace === "adiós");

// 2. Marcadores imperfectos de modelos pequeños
e = edits("```\n<<<<< AL FINAL\nTexto\n>>>>> FIN\n```");
check("marcadores cortos con valla", e.length === 1 && e[0].replace === "Texto", JSON.stringify(e));
e = edits("<<<<<<< AL FINAL\nSin cierre");
check("sin cierre se acepta al terminar", e.length === 1 && e[0].replace === "Sin cierre");
check("pendiente mientras llega", parseReply("<<<<<<< AL FINAL\nmedio", true).some((p) => p.type === "pending"));

// 3. Contenido sin bloques en modo escribir → se envuelve
let msg = { content: "¡Claro! Aquí tienes un párrafo sobre la Primera Guerra Mundial:\n\nLa Primera Guerra Mundial (1914-1918) fue un conflicto global.\n\nSus consecuencias marcaron el siglo XX.\n\n¿Quieres que añada más detalles?" };
wrapLooseContent(msg);
e = edits(msg.content);
check("contenido suelto se envuelve", e.length === 1 && e[0].kind === "append");
check("sin la introducción", e[0] && !/Claro|Aquí tienes/.test(e[0].replace), e[0]?.replace);
check("sin la pregunta final", e[0] && !/Quieres/.test(e[0].replace));
check("conserva los dos párrafos", e[0] && /1914-1918/.test(e[0].replace) && /siglo XX/.test(e[0].replace));

msg = { content: "```markdown\n## Conclusión\n\nTodo bien.\n```" };
wrapLooseContent(msg);
e = edits(msg.content);
check("quita la valla markdown", e.length === 1 && e[0].replace === "## Conclusión\n\nTodo bien.", e[0]?.replace);

msg = { content: "Hecho.\n\n<<<<<<< AL FINAL\nYa con bloque\n>>>>>>> FIN" };
const before = msg.content;
wrapLooseContent(msg);
check("no toca respuestas que ya traen bloques", msg.content === before);

msg = { content: "<think>razono</think>\nUn poema breve." };
wrapLooseContent(msg);
e = edits(msg.content);
check("ignora <think>", e.length === 1 && e[0].replace === "Un poema breve.", e[0]?.replace);

console.log(fails ? `\n${fails} fallos` : "\nTodo correcto");
process.exit(fails ? 1 : 0);

// Pruebas del clasificador de intención del chat: node tests/intent.test.js
const { classify } = require("../src/intent.js");

const cases = {
  ask: [
    "resume lo que dice este documento",
    "Resume el documento",
    "¿De qué trata este documento?",
    "de que trata el documento",
    "qué atajos de teclado hay",
    "¿Cuántos atajos se mencionan?",
    "explica el bloque de código",
    "explícame qué hace la tabla",
    "dime cuál es la idea principal",
    "hay errores de ortografía?",
    "¿Está bien escrito?",
    "analiza el estilo del texto",
    "qué opinas del documento",
    "revisa si hay incoherencias y dímelo",
    "haz un resumen del documento",
    "dame un resumen",
    "¿quién escribió esto?",
    "como puedo mejorar este texto",
    "¿Qué le falta al documento?",
    "cuál es el tema principal",
    "compara la introducción con la conclusión",
    "lista los atajos que aparecen",
    "¿Es correcto el código de Rust?",
    "¿por qué se usa Tauri?",
    "Tradúceme al inglés el primer párrafo, solo para entenderlo",
    "¿Puedes explicarme el código?",
    "no lo agregues, solo dime cómo quedaría una conclusión",
    "¿Qué significa Tauri?",
    "cuántas palabras tiene",
    "busca dónde se habla de guardar",
    "dime tu opinión sobre la tabla",
    "¿Crees que la introducción es clara?",
  ],
  write: [
    "al final agrega un parrafo hablando sobre la primera guerra mundial",
    "agrega un párrafo sobre la segunda guerra mundial",
    "añade una conclusión",
    "escribe una introducción",
    "un poema sobre el mar",
    "la primera guerra mundial",
    "Corrige la ortografía y la gramática",
    "Mejora la redacción sin cambiar el sentido",
    "Añade un índice al principio",
    "Tradúcelo al inglés",
    "¿puedes añadir un párrafo sobre Rust?",
    "¿Podrías escribir una conclusión?",
    "quiero que agregues una sección de instalación",
    "por favor agrega ejemplos de uso",
    "resume el documento y agrégalo al final",
    "haz una tabla con los atajos de macOS",
    "pon el título en mayúsculas",
    "elimina la lista de tareas",
    "cambia Rust por Go",
    "crea una sección de preguntas frecuentes",
    "continúa el texto",
    "genera 3 ideas para el blog",
    "Escribe un resumen al final del documento",
    "convierte la tabla en una lista",
    "necesito una sección sobre licencias",
    "dame un párrafo sobre la historia de Markdown",
    "¿qué tal si añades una conclusión?",
    "y si agregas una tabla de contenidos?",
    "hay que añadir una sección de licencia",
    "Agrega al final un resumen del documento",
    "Ahora en inglés",
    "más corto",
    "otro párrafo igual pero sobre Python",
    "¿Me escribes un párrafo sobre Rust?",
    "después del título pon una frase de bienvenida",
  ],
};

let fails = 0;
for (const [want, list] of Object.entries(cases)) {
  for (const text of list) {
    const got = classify(text);
    if (got !== want) {
      fails++;
      console.log(`FALLA  esperado ${want.padEnd(5)} obtuvo ${got.padEnd(5)}  «${text}»`);
    }
  }
}
const total = cases.ask.length + cases.write.length;
console.log(`${total - fails}/${total} correctas`);
process.exit(fails ? 1 : 0);

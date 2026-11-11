// Decide si un mensaje del chat es una pregunta (la respuesta se queda en el chat) o una petición
// de contenido o de cambios (lo que genere la IA va al documento).
// Regla de base del usuario: si no es una pregunta sobre el documento, se entiende que quiere
// añadir lo generado al documento.
(() => {
  // Quita tildes y pasa a minúsculas para comparar sin depender de cómo se escriba
  const norm = (s) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/\s+/g, " ").trim();

  // Verbos de escribir o cambiar el documento (imperativo, infinitivo y con pronombres: «agrégalo», «añádele»…)
  const WRITE = [
    "escrib", "redact", "agreg", "anad", "insert", "incluy", "inclu", "pon", "coloc", "crea", "genera",
    "complet", "continu", "sigue", "ampli", "extiend", "desarroll", "corrig", "correg", "reescrib", "reformul",
    "reemplaz", "sustitu", "cambi", "modific", "edit", "elimin", "borr", "quit", "suprim", "traduc",
    "mejor", "formate", "orden", "reorden", "convert", "convi", "transform", "acort", "alarg", "simplific",
    "pul", "arregl", "actualiz", "renombr", "numer", "estructur", "divid", "separ", "un", "mueve", "mov",
    "haz", "hace", "hacer", "rehaz", "dale formato", "aplica", "rellen", "list", "enumer", "tabula", "titul",
  ];
  // Verbos de leer, entender u opinar: la respuesta va al chat
  const ASK = [
    "resum", "explic", "dime", "dinos", "cuent", "analiz", "evalu", "valor", "opin", "comenta", "revis",
    "interpret", "compar", "identific", "detect", "encuentr", "busca", "localiz", "indica", "senala",
    "aclar", "describ", "sintetiz", "menciona", "enumera los", "lista los", "cita",
  ];
  const QUESTION_START = /^(que|cual|cuales|como|cuando|donde|adonde|quien|quienes|cuanto|cuanta|cuantos|cuantas|por que|para que|de que|en que|con que|a que|hay|es|son|esta|estan|tiene|tienen|existe|existen|puede|pueden|sabes|conoces|crees|consideras|deberia|seria|habla|trata|menciona|dice|incluye)\b/;
  // Peticiones educadas que en realidad piden hacer algo: «¿puedes añadir…?», «quiero que escribas…»
  const POLITE = /\b(puedes|podrias|podria|me ayudas a|ayudame a|quiero que|quisiera que|necesito que|me gustaria que|seria posible|te pido que|por favor|que tal si|y si|hay que|habria que|podemos|podriamos|deberias|deberiamos|me \w+(as|es))\b/;
  // Destino explícito en el documento
  const TARGET = /\b(al|en el|el) (documento|archivo|texto|final|inicio|principio)\b|\bal (final|inicio|principio)\b|\b(debajo|arriba|abajo|despues|antes) de\b|\b(este|ese|el) (parrafo|titulo|apartado|seccion|capitulo|punto)\b/;

  const startsWithAny = (word, list) => list.some((v) => word.startsWith(v));

  /** @returns {"ask" | "write"} */
  function classify(text) {
    const t = norm(text);
    if (!t) return "ask";
    const words = t.replace(/[¿?¡!.,;:()"«»]/g, " ").split(" ").filter(Boolean);
    const first = words[0] || "";
    const isQuestion = /[?¿]/.test(text) || QUESTION_START.test(t.replace(/^[¿¡]/, ""));
    const polite = POLITE.test(t);
    const target = TARGET.test(t);

    // Verbos presentes: al principio de la frase (imperativo) o tras una fórmula educada
    const writeVerbAtStart = startsWithAny(first, WRITE) && !/^(un|una|unos|unas|uno|lista)$/.test(first);
    const askVerbAtStart = startsWithAny(first, ASK) || /^(lista|enumera) (los|las|el|la)\b/.test(t) && !target;
    const anyWriteVerb = words.some((w, i) => i < 12 && startsWithAny(w, WRITE.filter((v) => v.length > 3)) && !/^(una?s?|uno)$/.test(w));

    // Lo pide explícitamente: «solo para entenderlo», «no lo agregues», «respóndeme en el chat»
    if (/\b(solo|solamente) (para|quiero) (entender|saber|leer|ver|consultar)|\bno (lo |la |los |las )?(agregues|anadas|pongas|cambies|modifiques|toques|insertes)\b|\b(en|por) el chat\b|\bsin (cambiar|tocar|modificar) el (documento|archivo|texto)\b/.test(t)) return "ask";
    // «haz un resumen», «dame tu opinión»: verbo genérico + algo que se lee, no que se escribe
    if (/^(haz|hazme|hace|dame|dime|muestrame|ensename|quiero|necesito|me das|me haces)\b/.test(t) && !target &&
        /\b(resumen|explicacion|analisis|opinion|valoracion|critica|evaluacion|comentarios?|feedback|sugerencias|recomendaciones|correcciones que|errores|problemas|idea principal|tema principal)\b/.test(t)) return "ask";
    // «resume el documento» → chat; «resume el documento y agrégalo al final» → documento
    if (askVerbAtStart) return target && anyWriteVerb && /\b(y|e) \w*(agreg|anad|pon|insert|escrib|inclu)/.test(t) ? "write" : "ask";
    if (writeVerbAtStart) return "write";
    if (isQuestion) {
      // «¿puedes añadir un párrafo…?» es una orden con forma de pregunta
      if ((polite || /^(me )?(puedes|podrias)/.test(t)) && anyWriteVerb) return "write";
      return "ask";
    }
    if (polite && anyWriteVerb) return "write";
    if (polite && words.some((w) => startsWithAny(w, ASK))) return "ask";
    // Sin pregunta: se entiende que quiere contenido en el documento («un poema sobre el mar»)
    return "write";
  }

  const api = { classify };
  if (typeof module !== "undefined") module.exports = api;
  else window.Intent = api;
})();

'use strict';
const fs = require('fs');
const path = require('path');

// Config de la app (NO la de Claude Code). Vive en userData y es lo unico que
// la app escribe fuera de su propia cache.

const DEFAULTS = {
  syncDir: null,        // carpeta compartida donde se dejan los digests
  machineLabel: null,   // como se llama esta maquina en la UI
  redact: false,        // ocultar titulos y rutas en el digest que se publica
  autoPublish: true,    // reescribir el digest despues de cada reindexado
  archived: [],         // sessionIds que quedan fuera de la lista por defecto
  pricing: null,        // tabla de precios propia; null = la que trae la app
  showCosts: true,      // false = mostrar solo tokens, sin estimar plata
  consentAt: null,      // cuando aceptaste el aviso de que se leen tus datos
};

class AppSettings {
  constructor(dir) {
    this.file = path.join(dir, 'settings.json');
    this.values = Object.assign({}, DEFAULTS);
    try {
      Object.assign(this.values, JSON.parse(fs.readFileSync(this.file, 'utf8')));
    } catch { /* primera vez o archivo roto: se usan los defaults */ }
  }

  get() {
    return Object.assign({}, this.values);
  }

  set(patch) {
    for (const [k, v] of Object.entries(patch || {})) {
      if (k in DEFAULTS) this.values[k] = v;
    }
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.values, null, 2));
    } catch { /* si no se puede escribir, al menos queda en memoria */ }
    return this.get();
  }
}

module.exports = { AppSettings, DEFAULTS };

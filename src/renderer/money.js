import { useEffect, useState } from 'react';
import { fmtUSD, fmtTokens } from './util.js';

// Estado global chiquito para el interruptor dólares / tokens.
// Los tokens son EXACTOS: salen del transcript. El costo es SIEMPRE estimado,
// porque depende de una tabla de precios que puede estar vieja, y porque la
// cuenta es por suscripción y no se factura por token.

let mostrar = true;
const subs = new Set();

export function setShowCosts(v) {
  mostrar = !!v;
  for (const fn of subs) fn(mostrar);
}

export function getShowCosts() { return mostrar; }

export function useShowCosts() {
  const [v, setV] = useState(mostrar);
  useEffect(() => {
    subs.add(setV);
    setV(mostrar);
    return () => { subs.delete(setV); };
  }, []);
  return v;
}

// Muestra plata o tokens según el interruptor. Si no hay tokens para mostrar
// como alternativa, devuelve un guion en vez de inventar un número.
export function useMoney() {
  const show = useShowCosts();
  return {
    show,
    // valor principal de una tarjeta
    valor: (usd, tokens) => (show ? fmtUSD(usd) : (tokens == null ? '—' : fmtTokens(tokens))),
    // etiqueta que acompaña al valor
    unidad: show ? 'equivalente API (aprox.)' : 'tokens facturados',
    // costo suelto en una lista o chip; null significa "no lo muestres"
    costo: (usd) => (show ? fmtUSD(usd) : null),
    aprox: show ? ' (aprox.)' : '',
  };
}

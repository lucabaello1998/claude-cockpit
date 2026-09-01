'use strict';
const mcp = require('./mcpClient.cjs');
const projectsEdit = require('./projectsEdit.cjs');

// Que necesita la app para que cada cosa funcione.
//
// Nada de esto es obligatorio: sin ningun MCP la app igual muestra tus
// conversaciones, tus tokens, tus costos y tus memorias, que salen de leer
// archivos. Los MCP habilitan lo que necesita hablar con un servicio.
//
// Antes esto no estaba en ningun lado: si no tenias el MCP de Azure DevOps, el
// boton de Boards aparecia deshabilitado y no habia forma de saber que faltaba
// ni como conseguirlo.
//
// Cada requisito trae ademas una PRUEBA real. Documentar como configurarlo no
// alcanza: lo unico que confirma que quedo bien es pedirle datos al servidor.

const REQUISITOS = [
  {
    id: 'ado',
    titulo: 'Azure DevOps',
    habilita: 'El tablero de Boards con tus work items reales: filtros por sprint, responsable y nivel, el detalle con la discusión, y poder cambiar estado o reasignar desde acá.',
    nombres: ['ado'],
    paquete: '@azure-devops/mcp',
    // El nombre tiene que ser exactamente "ado": es el que busca boards.
    nombreFijo: 'ado',
    campos: [
      {
        id: 'organizacion',
        label: 'Organización',
        ayuda: 'Lo que va después de dev.azure.com/ en la URL. Por ejemplo, en https://dev.azure.com/miempresa es "miempresa".',
        ejemplo: 'miempresa',
      },
      {
        id: 'pat',
        label: 'Personal Access Token',
        secreto: true,
        ayuda: 'Se saca de Azure DevOps → User settings → Personal access tokens → New Token. Alcanza con permisos de lectura de Work Items; para cambiar estado o comentar desde la app hace falta lectura y escritura.',
      },
    ],
  },
  {
    id: 'jira',
    titulo: 'Jira / Atlassian',
    habilita: 'Ver tus proyectos de Jira en Boards, con los mismos filtros y el mismo detalle que Azure DevOps.',
    nombres: ['jira', 'atlassian', 'mcp-atlassian'],
    // No hay un servidor unico, asi que se ofrecen los dos caminos reales en
    // vez de un parrafo que te deja igual que antes. Cual conviene depende de
    // si querés autorizar con tu cuenta o con un token.
    opciones: [
      {
        id: 'oficial',
        titulo: 'Atlassian oficial (remoto)',
        resumen: 'El servidor que mantiene Atlassian. No hace falta token: autorizás con tu cuenta desde el navegador.',
        nombreFijo: 'atlassian',
        campos: [],
        // Es un servidor remoto: la app escribe la definicion, pero la
        // autorizacion es un OAuth que corre Claude Code, no esta app.
        despues: 'Ahora abrí Claude Code y ejecutá /mcp para autorizar la conexión con tu cuenta de Atlassian. Hasta que lo hagas, la app lo va a ver configurado pero sin permiso.',
        definicion: () => ({ type: 'sse', url: 'https://mcp.atlassian.com/v1/sse' }),
      },
      {
        id: 'comunidad',
        titulo: 'mcp-atlassian (comunidad)',
        resumen: 'Corre en tu máquina con un token de API. Queda listo sin pasos extra, pero hay que generar el token.',
        nombreFijo: 'jira',
        requiere: 'uvx (viene con uv, el instalador de paquetes de Python)',
        campos: [
          {
            id: 'url',
            label: 'URL de tu Jira',
            ayuda: 'La dirección de tu sitio, tal cual la usás en el navegador.',
            ejemplo: 'https://miempresa.atlassian.net',
          },
          {
            id: 'email',
            label: 'Tu email de Atlassian',
            ayuda: 'El mismo con el que entrás a Jira.',
            ejemplo: 'vos@miempresa.com',
          },
          {
            id: 'token',
            label: 'API token',
            secreto: true,
            ayuda: 'Se genera en id.atlassian.com/manage-profile/security/api-tokens → Create API token. No es tu contraseña.',
          },
        ],
        definicion: (v) => {
          const url = String(v.url || '').trim().replace(/\/+$/, '');
          if (!/^https:\/\/[\w.-]+/.test(url)) {
            throw new Error('La URL tiene que empezar con https:// y ser la de tu sitio de Jira.');
          }
          const email = String(v.email || '').trim();
          if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error('Ese email no parece válido.');
          if (!String(v.token || '').trim()) throw new Error('Falta el API token.');
          return {
            type: 'stdio',
            command: 'uvx',
            args: ['mcp-atlassian'],
            env: {
              JIRA_URL: url,
              JIRA_USERNAME: email,
              JIRA_API_TOKEN: String(v.token).trim(),
            },
          };
        },
      },
    ],
  },
  {
    id: 'grafo',
    titulo: 'Grafo de código',
    habilita: 'El explorador de arquitectura: buscar símbolos, seguir llamadas entre funciones y ver la estructura de un repo indexado.',
    nombres: ['codebase-memory-mcp', 'graphify'],
    paquete: null,
    manual: 'Se instala aparte porque indexa tus repos en una base local, no es un paquete que se baje al vuelo. Hay dos: graphify (github.com/Graphify-Labs/graphify) y codebase-memory-mcp. La app soporta los dos y los distingue en Memorias. Una vez instalado y agregado a Claude Code, se detecta solo.',
    enlaces: [
      { texto: 'graphify en GitHub', url: 'https://github.com/Graphify-Labs/graphify' },
    ],
  },
];

// --- deteccion ---------------------------------------------------------------

function encontrado(req) {
  const disponibles = mcp.servidoresDisponibles();
  for (const n of req.nombres) {
    const s = disponibles.find((x) => String(x.name).toLowerCase() === n);
    if (s) return s;
  }
  // Para Jira tambien vale cualquier nombre que suene a eso.
  if (req.id === 'jira') {
    return disponibles.find((x) => /jira|atlassian/i.test(String(x.name))) || null;
  }
  return null;
}

function estado() {
  return REQUISITOS.map((r) => {
    const s = encontrado(r);
    return {
      id: r.id,
      titulo: r.titulo,
      habilita: r.habilita,
      paquete: r.paquete,
      manual: r.manual || null,
      enlaces: r.enlaces || null,
      campos: r.campos || null,
      opciones: (r.opciones || []).map((o) => ({
        id: o.id, titulo: o.titulo, resumen: o.resumen,
        requiere: o.requiere || null, campos: o.campos || [], despues: o.despues || null,
      })),
      detectado: !!s,
      servidor: s ? s.name : null,
      alcance: s ? s.alcance : null,
      // Si lo define un proyecto conviene decirlo: abrir el panel levanta ese
      // proceso, y no es obvio de donde sale.
      definidoPor: s && s.proyecto ? s.proyecto : null,
    };
  });
}

// --- configuracion -----------------------------------------------------------

// El servidor de Azure DevOps espera el token ya en base64 de "usuario:token",
// que es la forma que usa la autenticacion Basic. Pedirle eso al usuario seria
// una trampa: se acepta el token tal cual sale de Azure DevOps y se codifica
// aca. Si alguien pega uno ya codificado se detecta y se deja como esta.
function tokenBasic(pat) {
  const v = String(pat || '').trim();
  if (!v) throw new Error('Falta el token.');
  try {
    const dec = Buffer.from(v, 'base64').toString('utf8');
    // Ya venia codificado como usuario:token.
    if (/^[\w.@-]+:[\x20-\x7e]+$/.test(dec) && dec.includes(':')) return v;
  } catch { /* no era base64, sigue */ }
  return Buffer.from('ado:' + v).toString('base64');
}

function configurar(userDataDir, id, valores, opcionId) {
  const req = REQUISITOS.find((r) => r.id === id);
  if (!req) throw new Error('Requisito desconocido.');
  if (req.manual) throw new Error('Este se instala a mano: ' + req.manual);

  const v = valores || {};

  // Requisitos con varias implementaciones: cada opcion arma su definicion.
  if (req.opciones && req.opciones.length) {
    const op = req.opciones.find((o) => o.id === opcionId);
    if (!op) throw new Error('Elegí una de las opciones.');
    const r = projectsEdit.setUserMcp(userDataDir, op.nombreFijo, op.definicion(v));
    return { ...r, despues: op.despues || null };
  }

  if (id === 'ado') {
    const org = String(v.organizacion || '').trim();
    if (!org) throw new Error('Falta la organización.');
    if (!/^[A-Za-z0-9._-]+$/.test(org)) {
      throw new Error('Esa organización tiene caracteres raros: es solo el nombre, no la URL entera.');
    }
    return projectsEdit.setUserMcp(userDataDir, req.nombreFijo, {
      type: 'stdio',
      command: 'npx',
      args: ['-y', req.paquete, org, '--authentication', 'pat'],
      env: { PERSONAL_ACCESS_TOKEN: tokenBasic(v.pat) },
    });
  }
  throw new Error('Ese requisito no se configura desde acá.');
}

// --- prueba ------------------------------------------------------------------

// Documentar como configurarlo no alcanza: lo unico que confirma que quedo
// bien es pedirle datos de verdad al servidor.
async function probar(id) {
  const req = REQUISITOS.find((r) => r.id === id);
  if (!req) throw new Error('Requisito desconocido.');

  if (id === 'ado') {
    const ado = require('./ado.cjs');
    const proyectos = await ado.proyectos();
    return {
      ok: true,
      detalle: proyectos.length
        ? `Anda: ${proyectos.length} proyectos (${proyectos.slice(0, 3).map((p) => p.name).join(', ')}${proyectos.length > 3 ? '…' : ''}).`
        : 'Conecta, pero no aparece ningún proyecto. Revisá que el token tenga permiso de lectura.',
    };
  }

  if (id === 'jira') {
    const boards = require('./boards.cjs');
    const p = await boards.jiraProyectos();
    return { ok: true, detalle: `Anda: ${p.length} proyectos de Jira.` };
  }

  if (id === 'grafo') {
    const graph = require('./mcpGraph.cjs');
    if (!graph.available()) throw new Error('No hay un servidor de grafo configurado.');
    const p = await graph.projects();
    return { ok: true, detalle: `Anda: ${p.length} repos indexados.` };
  }

  throw new Error('Ese requisito no se puede probar.');
}

module.exports = { estado, configurar, probar, tokenBasic, REQUISITOS };

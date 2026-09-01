'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const call = (channel, ...args) =>
  ipcRenderer.invoke(channel, ...args).then((r) => {
    if (!r || !r.ok) throw new Error((r && r.error) || 'fallo IPC');
    return r.data;
  });

contextBridge.exposeInMainWorld('cockpit', {
  snapshot: () => call('snapshot'),
  refresh: () => call('refresh'),
  session: (id, opts) => call('session', id, opts),
  threadImage: (id, ref) => call('threadImage', id, ref),
  agentImage: (file, ref) => call('agentImage', file, ref),
  agentThread: (file, opts) => call('agentThread', file, opts),
  search: (q, opts) => call('search', q, opts),
  memory: () => call('memory'),
  liveUsage: (forzar) => call('liveUsage', !!forzar),
  getSettings: () => call('getSettings'),
  setSettings: (patch) => call('setSettings', patch),
  pickSyncDir: () => call('pickSyncDir'),
  publishDigest: () => call('publishDigest'),
  toggleArchived: (id) => call('toggleArchived', id),
  getArchived: () => call('getArchived'),
  graphAvailable: () => call('graphAvailable'),
  graphProjects: () => call('graphProjects'),
  graphArchitecture: (p) => call('graphArchitecture', p),
  graphSearch: (p, o) => call('graphSearch', p, o),
  graphSnippet: (p, qn, n) => call('graphSnippet', p, qn, n),
  graphTrace: (p, fn, o) => call('graphTrace', p, fn, o),
  graphSubgraph: (p, o) => call('graphSubgraph', p, o),
  graphSchema: (p) => call('graphSchema', p),
  pkgPreview: (inc) => call('pkgPreview', inc),
  pkgExport: (inc) => call('pkgExport', inc),
  pkgOpen: () => call('pkgOpen'),
  pkgApply: (sel) => call('pkgApply', sel),
  pricingInfo: () => call('pricingInfo'),
  pricingFetchRemote: () => call('pricingFetchRemote'),
  pricingApply: (t) => call('pricingApply', t),
  pricingReset: () => call('pricingReset'),
  setShowCosts: (v) => call('setShowCosts', v),
  acceptConsent: () => call('acceptConsent'),
  projectsList: () => call('projectsList'),
  mcpSetUser: (n, d) => call('mcpSetUser', n, d),
  mcpRemoveUser: (n) => call('mcpRemoveUser', n),
  mcpRenameUser: (a, b) => call('mcpRenameUser', a, b),
  mcpSearchRegistry: (q, c) => call('mcpSearchRegistry', q, c),
  skillsList: () => call('skillsList'),
  skillsSearch: (q) => call('skillsSearch', q),
  skillsDetail: (s) => call('skillsDetail', s),
  skillsInstall: (n, c) => call('skillsInstall', n, c),
  skillRead: (d) => call('skillRead', d),
  skillSave: (d, c) => call('skillSave', d, c),
  skillCreate: (n, d, b) => call('skillCreate', n, d, b),
  skillDelete: (d) => call('skillDelete', d),
  skillFork: (d, n) => call('skillFork', d, n),
  pluginsList: () => call('pluginsList'),
  hooksList: () => call('hooksList'),
  workflowsList: () => call('workflowsList'),
  workflowRead: (f) => call('workflowRead', f),
  workflowSave: (f, c) => call('workflowSave', f, c),
  workflowDelete: (f) => call('workflowDelete', f),
  boardsProviders: () => call('boardsProviders'),
  boardsList: () => call('boardsList'),
  boardGet: (id) => call('boardGet', id),
  boardCreate: (n, c) => call('boardCreate', n, c),
  boardDelete: (id) => call('boardDelete', id),
  boardSaveColumns: (id, c) => call('boardSaveColumns', id, c),
  boardSaveCard: (id, t) => call('boardSaveCard', id, t),
  boardMoveCard: (id, t, c) => call('boardMoveCard', id, t, c),
  boardDeleteCard: (id, t) => call('boardDeleteCard', id, t),
  boardComment: (id, t, texto) => call('boardComment', id, t, texto),
  boardDeleteComment: (id, t, c) => call('boardDeleteComment', id, t, c),
  boardImport: (r, n) => call('boardImport', r, n),
  adoProjects: () => call('adoProjects'),
  adoTeams: (p) => call('adoTeams', p),
  adoConnection: () => call('adoConnection'),
  reqStatus: () => call('reqStatus'),
  briefing: (forzar) => call('briefing', forzar),
  installState: () => call('installState'),
  contextByProject: () => call('contextByProject'),
  memoryRead: (proj, file) => call('memoryRead', proj, file),
  memorySave: (proj, datos) => call('memorySave', proj, datos),
  memoryDelete: (proj, file) => call('memoryDelete', proj, file),
  contextCandidates: (file) => call('contextCandidates', file),
  contextPrompt: (sesion, proj) => call('contextPrompt', sesion, proj),
  updaterState: () => call('updaterState'),
  updaterCheck: () => call('updaterCheck'),
  updaterDownload: () => call('updaterDownload'),
  updaterInstall: () => call('updaterInstall'),
  reqConfigure: (id, valores, opcion) => call('reqConfigure', id, valores, opcion),
  reqTest: (id) => call('reqTest', id),
  adoSprints: (p, e) => call('adoSprints', p, e),
  adoStates: (p, tipo) => call('adoStates', p, tipo),
  adoBoard: (p, e, filtros) => call('adoBoard', p, e, filtros),
  adoDetail: (p, id) => call('adoDetail', p, id),
  adoSetState: (p, id, estado) => call('adoSetState', p, id, estado),
  adoAssign: (p, id, quien) => call('adoAssign', p, id, quien),
  adoComment: (p, id, texto) => call('adoComment', p, id, texto),
  jiraProjects: () => call('jiraProjects'),
  jiraBoard: (p) => call('jiraBoard', p),
  hookAdd: (d) => call('hookAdd', d),
  hookEdit: (id, c) => call('hookEdit', id, c),
  hookDelete: (id) => call('hookDelete', id),
  hookScriptRead: (n) => call('hookScriptRead', n),
  hookScriptSave: (n, c) => call('hookScriptSave', n, c),
  hookScriptDelete: (n) => call('hookScriptDelete', n),
  pluginSetEnabled: (id, v) => call('pluginSetEnabled', id, v),
  marketplaceAdd: (r) => call('marketplaceAdd', r),
  marketplaceUpdate: (n) => call('marketplaceUpdate', n),
  marketplaceRemove: (n) => call('marketplaceRemove', n),
  projectSetTrust: (r, v) => call('projectSetTrust', r, v),
  projectSetTools: (r, t) => call('projectSetTools', r, t),
  projectSetMcp: (r, s) => call('projectSetMcp', r, s),
  projectsMerge: (rs, g, t) => call('projectsMerge', rs, g, t),
  projectRemove: (r) => call('projectRemove', r),
  paths: () => call('paths'),
  openPath: (p) => call('openPath', p),
  revealPath: (p) => call('revealPath', p),
  openExternal: (u) => call('openExternal', u),

  onUpdated: (cb) => {
    const h = (_e, d) => cb(d);
    ipcRenderer.on('cockpit:updated', h);
    return () => ipcRenderer.removeListener('cockpit:updated', h);
  },
  onUpdater: (cb) => {
    const h = (_e, d) => cb(d);
    ipcRenderer.on('cockpit:updater', h);
    return () => ipcRenderer.removeListener('cockpit:updater', h);
  },
  onIndexing: (cb) => {
    const h = (_e, d) => cb(d);
    ipcRenderer.on('cockpit:indexing', h);
    return () => ipcRenderer.removeListener('cockpit:indexing', h);
  },
  onError: (cb) => {
    const h = (_e, d) => cb(d);
    ipcRenderer.on('cockpit:error', h);
    return () => ipcRenderer.removeListener('cockpit:error', h);
  },
});

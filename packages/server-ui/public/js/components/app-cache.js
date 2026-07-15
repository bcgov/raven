/**
 * App discovery cache — loads server config + cached discovery results on
 * startup (no SSH). Discovery only happens when the user explicitly requests
 * it via the Discover view, one server at a time.
 *
 * Data structure:
 *   window.appData = {
 *     loaded: boolean,
 *     serverConfig: [{ name, role, description }, ...],
 *     servers: { int01: [...], test01: [...], ... },
 *     apps: ['RRS', 'DMS', ...],
 *     components: { 'RRS': ['rrs-api', 'rrs-web'], ... }
 *   }
 */
window.appData = { loaded: false, serverConfig: [], servers: {}, apps: [], components: {} };

let loadPromise = null;

/** Rebuild the global apps[] and components{} from servers data. */
function rebuildAppIndex() {
  const appSet = new Set();
  const compMap = {};

  for (const apps of Object.values(window.appData.servers)) {
    for (const app of apps) {
      appSet.add(app.app);
      if (!compMap[app.app]) compMap[app.app] = new Set();
      compMap[app.app].add(app.component);
    }
  }

  window.appData.apps = [...appSet].sort();
  window.appData.components = {};
  for (const [app, comps] of Object.entries(compMap)) {
    window.appData.components[app] = [...comps].sort();
  }
}

/**
 * Load server config and cached discovery data. No SSH — reads from
 * the server-side cache file. Instant on startup.
 */
export function loadAppData() {
  if (loadPromise) return loadPromise;

  loadPromise = Promise.all([
    fetch('/api/servers').then(r => r.json()),
    fetch('/api/discover/cache').then(r => r.json()),
  ])
    .then(([serverConfig, cacheData]) => {
      window.appData.serverConfig = serverConfig;

      for (const srv of (cacheData.servers || [])) {
        window.appData.servers[srv.server] = srv.apps;
      }

      rebuildAppIndex();
      window.appData.loaded = true;
    })
    .catch(err => {
      console.error('Failed to load app data:', err);
      window.appData.loaded = true;
    });

  return loadPromise;
}

/**
 * Merge discovery results for a single server into the global cache.
 * Called from the Discover view after the user discovers a server.
 */
export function mergeServerDiscovery(server, apps) {
  window.appData.servers[server] = apps;
  rebuildAppIndex();
}

/**
 * Reload app data (e.g. after server config change). Clears cache and re-fetches.
 */
export function reloadAppData() {
  loadPromise = null;
  window.appData = { loaded: false, serverConfig: [], servers: {}, apps: [], components: {} };
  return loadAppData();
}

/** Wait until app data is loaded. */
export function whenReady() {
  return loadPromise || Promise.resolve();
}

/**
 * Create an app name dropdown.
 * @param {string} id - Element ID for the select
 * @param {boolean} includeAll - Add an empty "All apps" option
 */
export function createAppPicker(id = 'app-select', includeAll = false) {
  let html = `<select id="${id}" class="form-select">`;
  if (includeAll) html += '<option value="">All apps</option>';
  for (const app of window.appData.apps) {
    html += `<option value="${app}">${app}</option>`;
  }
  html += '</select>';
  return html;
}

/**
 * Create a component dropdown for a given app.
 * @param {string} id - Element ID
 * @param {string} app - App name to filter components
 */
export function createComponentPicker(id = 'comp-select', app = '') {
  const comps = app ? (window.appData.components[app] || []) : getAllComponents();
  let html = `<select id="${id}" class="form-select">`;
  for (const comp of comps) {
    html += `<option value="${comp}">${comp}</option>`;
  }
  html += '</select>';
  return html;
}

/** Get all unique components across all apps. */
function getAllComponents() {
  const all = new Set();
  for (const comps of Object.values(window.appData.components)) {
    for (const c of comps) all.add(c);
  }
  return [...all].sort();
}

/**
 * Update a component picker when the app selection changes.
 * Call this in a change listener on the app picker.
 */
export function updateComponentPicker(compSelectId, app) {
  const el = document.getElementById(compSelectId);
  if (!el) return;
  const comps = app ? (window.appData.components[app] || []) : getAllComponents();
  el.innerHTML = comps.map(c => `<option value="${c}">${c}</option>`).join('');
}

// Expose globally
window.loadAppData = loadAppData;
window.reloadAppData = reloadAppData;
window.whenAppDataReady = whenReady;
window.createAppPicker = createAppPicker;
window.createComponentPicker = createComponentPicker;
window.updateComponentPicker = updateComponentPicker;
window.mergeServerDiscovery = mergeServerDiscovery;

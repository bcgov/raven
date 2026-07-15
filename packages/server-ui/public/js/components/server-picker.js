/**
 * Server picker dropdown component.
 * Reads server list dynamically from window.appData.serverConfig.
 */

export function createServerPicker(id = 'server-select', includeAll = false) {
  const servers = window.appData?.serverConfig || [];
  let html = `<select id="${id}" class="form-select">`;
  if (includeAll) {
    html += `<option value="">All servers</option>`;
  }
  for (const s of servers) {
    html += `<option value="${s.name}">${s.name} (${s.role})</option>`;
  }
  html += '</select>';
  return html;
}

/**
 * Get the role label for a server name.
 * @param {string} serverName - e.g. "int01"
 * @returns {string} Role label, e.g. "DEV"
 */
export function getServerRole(serverName) {
  const servers = window.appData?.serverConfig || [];
  const match = servers.find(s => s.name === serverName);
  return match ? match.role : serverName;
}

/**
 * Get all configured server names as an array.
 * @returns {string[]}
 */
export function getServerNames() {
  return (window.appData?.serverConfig || []).map(s => s.name);
}

window.createServerPicker = createServerPicker;
window.getServerRole = getServerRole;
window.getServerNames = getServerNames;

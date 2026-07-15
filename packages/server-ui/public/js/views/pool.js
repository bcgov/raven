/**
 * Connection Pool view — JDBC pool config and recent pool events.
 */
window.views = window.views || {};

window.views.pool = {
  render() {
    const firstApp = window.appData.apps[0] || '';
    return `
      <div>
        <h2 class="section-title">Connection Pool</h2>
        <form id="pool-form" class="flex flex-wrap gap-3 items-end mb-4">
          <div>
            <label class="text-xs text-gray-500 block mb-1">Server</label>
            ${window.createServerPicker('pool-server')}
          </div>
          <div>
            <label class="text-xs text-gray-500 block mb-1">App</label>
            ${window.createAppPicker('pool-app')}
          </div>
          <div>
            <label class="text-xs text-gray-500 block mb-1">Component</label>
            ${window.createComponentPicker('pool-comp', firstApp)}
          </div>
          <button type="submit" id="pool-btn" class="btn-primary">Fetch Pool Info</button>
        </form>
        <div id="pool-result" class="card">
          <p class="text-gray-500">Select server, app, and component to view JDBC connection pool configuration and recent pool events.</p>
        </div>
      </div>
    `;
  },

  async init() {
    document.getElementById('pool-app').addEventListener('change', (e) => {
      window.updateComponentPicker('pool-comp', e.target.value);
    });

    document.getElementById('pool-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const server = document.getElementById('pool-server').value;
      const app = document.getElementById('pool-app').value.trim();
      const component = document.getElementById('pool-comp').value.trim();

      if (!app || !component) {
        window.showToast('App and component are required', 'error');
        return;
      }

      const result = document.getElementById('pool-result');
      result.innerHTML = '<div class="flex items-center gap-2"><span class="spinner"></span> Reading pool config...</div>';

      try {
        const params = new URLSearchParams({ server, app, component });
        const res = await fetch(`/api/pool?${params}`);
        const data = await res.json();
        if (data.error) throw new Error(data.error);

        let html = '';

        // Pool Configuration
        html += '<h3 class="subsection-title mb-3">JDBC Pool Configuration</h3>';
        if (data.pool && data.pool.length > 0) {
          for (const p of data.pool) {
            const healthClass = !p.maxActive ? 'pool-warning' : 'pool-healthy';
            html += `<div class="mb-4 p-3 rounded-lg" style="background:var(--bg-input)">`;
            html += `<div class="text-sm font-semibold mb-2 ${healthClass}">${escapeHtml(p.name || 'Default DataSource')}</div>`;
            html += '<dl class="pool-config-grid">';
            if (p.url) html += `<dt>URL</dt><dd>${escapeHtml(p.url)}</dd>`;
            if (p.driverClassName) html += `<dt>Driver</dt><dd>${escapeHtml(p.driverClassName)}</dd>`;
            if (p.maxActive) html += `<dt>Max Active</dt><dd>${escapeHtml(p.maxActive)}</dd>`;
            if (p.maxIdle) html += `<dt>Max Idle</dt><dd>${escapeHtml(p.maxIdle)}</dd>`;
            if (p.minIdle) html += `<dt>Min Idle</dt><dd>${escapeHtml(p.minIdle)}</dd>`;
            if (p.maxWait) html += `<dt>Max Wait</dt><dd>${escapeHtml(p.maxWait)} ms</dd>`;
            if (p.validationQuery) html += `<dt>Validation</dt><dd>${escapeHtml(p.validationQuery)}</dd>`;
            html += '</dl></div>';
          }
        } else {
          html += '<p class="text-gray-500 text-sm mb-4">No JDBC pool configuration found in context.xml. The component may not use a database connection pool, or the config may be in a different location.</p>';
        }

        // Pool Events
        html += '<h3 class="subsection-title mb-3 mt-4">Recent Pool Events</h3>';
        if (data.events && data.events.length > 0) {
          html += '<div class="bg-gray-900 rounded-lg p-3 overflow-x-auto max-h-[400px] overflow-y-auto" style="background:var(--bg-log-output)">';
          for (const line of data.events) {
            html += `<div class="log-line"><span class="log-msg">${escapeHtml(line)}</span></div>`;
          }
          html += '</div>';
        } else {
          html += '<p class="text-green-400 text-sm">No pool-related events found in recent logs. Connection pool appears healthy.</p>';
        }

        result.innerHTML = html;
      } catch (err) {
        result.innerHTML = `<p class="text-red-400">${escapeHtml(err.message)}</p>`;
        window.showToast(err.message, 'error');
      }
    });
  }
};

function escapeHtml(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

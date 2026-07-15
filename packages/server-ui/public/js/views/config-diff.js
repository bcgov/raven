/**
 * Config Diff view — compare configs between environments.
 */
window.views = window.views || {};

window.views['config-diff'] = {
  render() {
    const firstApp = window.appData.apps[0] || '';
    return `
      <div>
        <h2 class="section-title">Config Diff</h2>
        <form id="diff-form" class="flex flex-wrap gap-3 items-end mb-4">
          <div>
            <label class="text-xs text-gray-500 block mb-1">App</label>
            ${window.createAppPicker('diff-app')}
          </div>
          <div>
            <label class="text-xs text-gray-500 block mb-1">Component</label>
            ${window.createComponentPicker('diff-comp', firstApp)}
          </div>
          <div>
            <label class="text-xs text-gray-500 block mb-1">Config file</label>
            <select id="diff-file" class="form-select">
              <option value="context.xml">context.xml</option>
              <option value="web.xml">web.xml</option>
              <option value="server.xml">server.xml</option>
            </select>
          </div>
          <div>
            <label class="text-xs text-gray-500 block mb-1">Servers</label>
            <input id="diff-servers" class="form-input w-48" value="int01,test01,prod01">
          </div>
          <button type="submit" id="diff-btn" class="btn-primary">Compare</button>
        </form>
        <div id="diff-result" class="card">
          <p class="text-gray-500">Select app and component, then click "Compare" to diff configs across environments.</p>
        </div>
      </div>
    `;
  },

  async init() {
    document.getElementById('diff-app').addEventListener('change', (e) => {
      window.updateComponentPicker('diff-comp', e.target.value);
    });

    document.getElementById('diff-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const app = document.getElementById('diff-app').value.trim();
      const component = document.getElementById('diff-comp').value.trim();
      const file = document.getElementById('diff-file').value;
      const servers = document.getElementById('diff-servers').value.trim();

      if (!app || !component) {
        window.showToast('App and component are required', 'error');
        return;
      }

      const result = document.getElementById('diff-result');
      result.innerHTML = '<div class="flex items-center gap-2"><span class="spinner"></span> Comparing configs...</div>';

      try {
        const params = new URLSearchParams({ app, component, file, servers });
        const res = await fetch(`/api/config-diff?${params}`);
        const data = await res.json();
        if (data.error) throw new Error(data.error);

        result.innerHTML = window.renderDiff(data.diff);
      } catch (err) {
        result.innerHTML = `<p class="text-red-400">${err.message}</p>`;
        window.showToast(err.message, 'error');
      }
    });
  }
};

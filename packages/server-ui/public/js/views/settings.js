/**
 * Settings view — configure server list.
 *
 * Reads/writes ~/bin/servers.conf (the CLI tools' config file).
 * Each server has: name, hostname, SSH user, sudo user, role, description, apps path, logs path.
 */
window.views = window.views || {};

window.views.settings = {
  render() {
    return `
      <div>
        <h2 class="section-title">Settings</h2>
        <div class="card">
          <h3 class="subsection-title mb-3">Configured Servers</h3>
          <p class="text-xs text-gray-500 mb-3">
            Add, remove, or edit servers. Changes are saved to <code class="text-gray-400">~/bin/servers.conf</code>
            and apply to both the web UI and CLI tools.
          </p>
          <div id="settings-table-wrap" style="overflow-x:auto"></div>
          <div class="flex gap-3 mt-3">
            <button id="settings-add-btn" type="button" class="btn-secondary text-sm">+ Add Server</button>
            <button id="settings-save-btn" type="button" class="btn-primary text-sm">Save</button>
          </div>
          <div id="settings-status" class="mt-2"></div>
        </div>
      </div>
    `;
  },

  async init() {
    this.renderTable();

    document.getElementById('settings-add-btn').addEventListener('click', () => {
      this.addRow({ name: '', host: '', sshUser: '', sudoUser: '', role: '', description: '', appsBase: '/apps_ux', logsBase: '/apps_ux/logs' });
    });

    document.getElementById('settings-save-btn').addEventListener('click', () => {
      this.save();
    });
  },

  renderTable() {
    const servers = window.appData.serverConfig || [];
    const wrap = document.getElementById('settings-table-wrap');

    let html = `
      <table class="data-table" id="settings-server-table">
        <thead><tr>
          <th>Name</th>
          <th>Hostname</th>
          <th>SSH User</th>
          <th>Sudo User</th>
          <th>Role</th>
          <th>Description</th>
          <th>Apps Path</th>
          <th>Logs Path</th>
          <th style="width:3rem"></th>
        </tr></thead>
        <tbody>`;

    for (const s of servers) {
      html += this.rowHtml(s);
    }

    html += '</tbody></table>';
    wrap.innerHTML = html;

    // Wire up remove buttons
    wrap.querySelectorAll('.settings-remove-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.target.closest('tr').remove();
      });
    });
  },

  rowHtml(s) {
    return `
      <tr>
        <td><input type="text" class="form-input w-full srv-name" value="${escAttr(s.name)}" placeholder="hostname"></td>
        <td><input type="text" class="form-input w-full srv-host" value="${escAttr(s.host)}" placeholder="host.example.internal"></td>
        <td><input type="text" class="form-input w-full srv-ssh-user" value="${escAttr(s.sshUser)}" placeholder="username"></td>
        <td><input type="text" class="form-input w-full srv-sudo-user" value="${escAttr(s.sudoUser)}" placeholder="appuser"></td>
        <td><input type="text" class="form-input w-full srv-role" value="${escAttr(s.role)}" placeholder="DEV" style="width:5rem"></td>
        <td><input type="text" class="form-input w-full srv-desc" value="${escAttr(s.description)}" placeholder="INT Tomcat"></td>
        <td><input type="text" class="form-input w-full srv-apps-base" value="${escAttr(s.appsBase)}" placeholder="/apps_ux"></td>
        <td><input type="text" class="form-input w-full srv-logs-base" value="${escAttr(s.logsBase)}" placeholder="/apps_ux/logs"></td>
        <td><button type="button" class="settings-remove-btn text-red-400 hover:text-red-300 text-lg px-2" title="Remove">✕</button></td>
      </tr>`;
  },

  addRow(s) {
    const tbody = document.querySelector('#settings-server-table tbody');
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><input type="text" class="form-input w-full srv-name" value="${escAttr(s.name)}" placeholder="hostname"></td>
      <td><input type="text" class="form-input w-full srv-host" value="${escAttr(s.host)}" placeholder="host.example.internal"></td>
      <td><input type="text" class="form-input w-full srv-ssh-user" value="${escAttr(s.sshUser)}" placeholder="username"></td>
      <td><input type="text" class="form-input w-full srv-sudo-user" value="${escAttr(s.sudoUser)}" placeholder="appuser"></td>
      <td><input type="text" class="form-input w-full srv-role" value="${escAttr(s.role)}" placeholder="DEV" style="width:5rem"></td>
      <td><input type="text" class="form-input w-full srv-desc" value="${escAttr(s.description)}" placeholder="INT Tomcat"></td>
      <td><input type="text" class="form-input w-full srv-apps-base" value="${escAttr(s.appsBase)}" placeholder="/apps_ux"></td>
      <td><input type="text" class="form-input w-full srv-logs-base" value="${escAttr(s.logsBase)}" placeholder="/apps_ux/logs"></td>
      <td><button type="button" class="settings-remove-btn text-red-400 hover:text-red-300 text-lg px-2" title="Remove">✕</button></td>`;
    tr.querySelector('.settings-remove-btn').addEventListener('click', () => tr.remove());
    tbody.appendChild(tr);
    tr.querySelector('.srv-name').focus();
  },

  async save() {
    const rows = document.querySelectorAll('#settings-server-table tbody tr');
    const servers = [];
    for (const row of rows) {
      const name = row.querySelector('.srv-name').value.trim();
      const host = row.querySelector('.srv-host').value.trim();
      const sshUser = row.querySelector('.srv-ssh-user').value.trim();
      const sudoUser = row.querySelector('.srv-sudo-user').value.trim();
      const role = row.querySelector('.srv-role').value.trim();
      const description = row.querySelector('.srv-desc').value.trim();
      const appsBase = row.querySelector('.srv-apps-base').value.trim() || '/apps_ux';
      const logsBase = row.querySelector('.srv-logs-base').value.trim() || '/apps_ux/logs';
      if (name) servers.push({ name, host, sshUser, sudoUser, role, description, appsBase, logsBase });
    }

    if (servers.length === 0) {
      window.showToast('At least one server is required', 'error');
      return;
    }

    const status = document.getElementById('settings-status');
    status.innerHTML = '<span class="text-gray-400 text-sm">Saving...</span>';

    try {
      const res = await fetch('/api/servers', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(servers),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to save');

      // Reload app data with new server config
      await window.reloadAppData();

      status.innerHTML = '<span class="text-green-400 text-sm">Saved! Server config updated.</span>';
      window.showToast('Server configuration saved', 'success');

      // Re-render the table with the saved data
      this.renderTable();
    } catch (err) {
      status.innerHTML = `<span class="text-red-400 text-sm">${escHtml(err.message)}</span>`;
      window.showToast(err.message, 'error');
    }
  }
};

function escAttr(str) {
  return String(str || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escHtml(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

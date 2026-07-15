/**
 * Hash router — maps #view to view modules.
 * Loads app discovery cache on startup, then renders views.
 * Manages global alert SSE stream for sidebar badge updates.
 */
const container = document.getElementById('view-container');
const navLinks = document.querySelectorAll('.nav-link');

// ── Global alert state ─────────────────────────────────────────────
let globalAlertSource = null;
let alertCount = 0;

function startGlobalAlertStream() {
  globalAlertSource = new EventSource('/api/alerts/stream');
  globalAlertSource.onmessage = (e) => {
    alertCount++;
    const badge = document.getElementById('alert-badge');
    const bell = document.getElementById('alert-bell');
    const bellCount = document.getElementById('alert-bell-count');
    if (badge) { badge.textContent = alertCount; badge.style.display = 'inline-flex'; }
    if (bell) { bell.style.display = 'inline-flex'; }
    if (bellCount) { bellCount.textContent = alertCount; }
    // Browser notification if tab not focused
    if (document.hidden && 'Notification' in window && Notification.permission === 'granted') {
      try {
        const data = JSON.parse(e.data);
        new Notification('Server Alert', { body: data.message });
      } catch { /* ignore parse errors */ }
    }
  };
  globalAlertSource.onerror = () => {
    // EventSource auto-reconnects; no action needed
  };
}

// ── Router ─────────────────────────────────────────────────────────
function navigate(hash) {
  const raw = (hash || '#dashboard').replace('#', '');
  const [viewName, queryStr] = raw.split('?', 2);
  const view = window.views?.[viewName];

  // Clean up SSE streams if navigating away
  if (window.views?.heap?._eventSource) {
    window.views.heap.stopStream();
  }
  if (window.views?.load?._eventSource) {
    window.views.load.stopStream();
  }
  if (window.views?.logtail?._timer) {
    window.views.logtail.stopTailing();
  }
  if (window.views?.alerts?._eventSource) {
    window.views.alerts.stopAlertStream();
  }

  // Reset alert badge when navigating to alerts
  if (viewName === 'alerts') {
    alertCount = 0;
    const badge = document.getElementById('alert-badge');
    if (badge) badge.style.display = 'none';
  }

  if (!view) {
    container.innerHTML = '<p class="text-gray-500">View not found.</p>';
    return;
  }

  // Update nav
  navLinks.forEach((link) => {
    link.classList.toggle('active', link.dataset.view === viewName);
  });

  // Render view, passing any query params
  const params = queryStr ? Object.fromEntries(new URLSearchParams(queryStr)) : null;
  container.innerHTML = view.render(params);
  if (view.init) view.init(params);
}

// ── Startup ────────────────────────────────────────────────────────

// Request notification permission
if ('Notification' in window && Notification.permission === 'default') {
  Notification.requestPermission();
}

// Load cached app data (no SSH — instant) then start routing
window.loadAppData().then(() => {
  window.addEventListener('hashchange', () => navigate(location.hash));
  navigate(location.hash);
  startGlobalAlertStream();
});

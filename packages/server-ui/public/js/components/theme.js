/**
 * Theme toggle — switches between dark and light mode.
 * Persists choice in localStorage.
 */
(function () {
  const STORAGE_KEY = 'server-monitor-theme';

  /** Apply the given theme ('dark' or 'light') to the document. */
  function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    updateIcon(theme);
  }

  /** Update the toggle button icon (sun for dark mode, moon for light). */
  function updateIcon(theme) {
    const btn = document.getElementById('theme-toggle');
    if (!btn) return;
    // Show sun icon in dark mode (click to go light), moon in light mode (click to go dark)
    btn.innerHTML = theme === 'dark' ? '&#9788;' : '&#9790;';
    btn.title = theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode';
  }

  /** Get the saved theme or default to 'dark'. */
  function getSavedTheme() {
    return localStorage.getItem(STORAGE_KEY) || 'dark';
  }

  /** Toggle between dark and light. */
  function toggle() {
    const current = document.documentElement.getAttribute('data-theme') || 'dark';
    const next = current === 'dark' ? 'light' : 'dark';
    localStorage.setItem(STORAGE_KEY, next);
    applyTheme(next);
  }

  // Apply saved theme immediately (before paint)
  applyTheme(getSavedTheme());

  // Wire up the toggle button once DOM is ready
  document.addEventListener('DOMContentLoaded', () => {
    const btn = document.getElementById('theme-toggle');
    if (btn) btn.addEventListener('click', toggle);
    updateIcon(getSavedTheme());
  });

  window.toggleTheme = toggle;
})();

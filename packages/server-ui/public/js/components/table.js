/**
 * Reusable data table renderer.
 */
export function renderTable(columns, rows, options = {}) {
  const { rowClass } = options;
  let html = '<table class="data-table"><thead><tr>';
  for (const col of columns) {
    html += `<th>${col.label}</th>`;
  }
  html += '</tr></thead><tbody>';
  for (const row of rows) {
    const cls = rowClass ? rowClass(row) : '';
    html += `<tr class="${cls}">`;
    for (const col of columns) {
      const val = typeof col.render === 'function' ? col.render(row) : (row[col.key] ?? '');
      html += `<td>${val}</td>`;
    }
    html += '</tr>';
  }
  html += '</tbody></table>';
  return html;
}

window.renderTable = renderTable;

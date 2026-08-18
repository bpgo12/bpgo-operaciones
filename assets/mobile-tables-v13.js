(() => {
  const enhance = (root = document) => {
    root.querySelectorAll?.('.table-wrap table:not(.mobile-card-table)').forEach((table) => {
      if (table.closest('.billing-records-panel')) return;

      const headings = [...table.querySelectorAll('thead th')]
        .map((heading) => heading.textContent.trim());
      if (!headings.length) return;

      table.classList.add('mobile-card-table');
      table.querySelectorAll('tbody tr').forEach((row) => {
        [...row.children].forEach((cell, index) => {
          if (cell.tagName !== 'TD') return;
          cell.dataset.label ||= headings[index] || 'Detalle';
        });
      });
    });
  };

  const start = () => {
    enhance();
    new MutationObserver((mutations) => {
      if (mutations.some((mutation) => mutation.addedNodes.length)) enhance();
    }).observe(document.body, { childList: true, subtree: true });
  };

  document.readyState === 'loading'
    ? document.addEventListener('DOMContentLoaded', start, { once: true })
    : start();
})();

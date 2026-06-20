/** Cetak dokumen A4 via browser — target harus ada di document.body (lihat PrintPortal). */

export function printDocument(elementId = 'vendor-invoice-a4-print', delayMs = 300) {
  return new Promise((resolve) => {
    const target = document.getElementById(elementId);
    if (!target) {
      resolve();
      return;
    }

    const cleanup = () => {
      document.body.classList.remove('doc-print-active');
      document.documentElement.removeAttribute('data-doc-print');
      resolve();
    };

    document.documentElement.removeAttribute('data-receipt-paper');
    document.documentElement.removeAttribute('data-receipt-profile');
    document.body.classList.add('doc-print-active');
    document.documentElement.setAttribute('data-doc-print', 'a4');

    requestAnimationFrame(() => {
      setTimeout(() => {
        window.print();
        if ('onafterprint' in window) {
          window.addEventListener('afterprint', cleanup, { once: true });
          setTimeout(cleanup, 3000);
        } else {
          setTimeout(cleanup, 800);
        }
      }, delayMs);
    });
  });
}

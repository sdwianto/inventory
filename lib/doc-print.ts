/** Cetak dokumen A4 via browser — target harus ada di document.body (lihat PrintPortal).
 *  `fileName` sementara mengganti document.title (jadi default nama "Save as PDF").
 */
export function printDocument(
  elementId = 'vendor-invoice-a4-print',
  delayMs = 300,
  fileName?: string,
) {
  return new Promise<void>((resolve) => {
    const target = document.getElementById(elementId);
    if (!target) {
      resolve();
      return;
    }

    const prevTitle = document.title;
    if (fileName?.trim()) {
      document.title = fileName.trim();
    }

    const cleanup = () => {
      document.body.classList.remove('doc-print-active');
      document.documentElement.removeAttribute('data-doc-print');
      if (fileName?.trim()) document.title = prevTitle;
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

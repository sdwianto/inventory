'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { resolvePrintLayout } from '@/lib/printer-settings';

/** Render children on document.body so thermal receipt is not inside .no-print ancestors. */
export default function PrintPortal({ children }: { children?: ReactNode }) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  if (!mounted || !children) return null;
  return createPortal(children, document.body);
}

function applyPrintDocumentAttrs(layout) {
  const root = document.documentElement;
  root.setAttribute('data-receipt-paper', String(layout.paperWidthMm));
  root.setAttribute('data-receipt-profile', layout.profileId);
  root.style.setProperty('--receipt-paper-mm', `${layout.paperWidthMm}mm`);
  root.style.setProperty('--receipt-printable-mm', `${layout.printableWidthMm}mm`);
  root.style.setProperty('--receipt-font-px', `${layout.fontSizePx}px`);
  root.style.setProperty('--receipt-line-height', String(layout.lineHeight));
  root.style.setProperty('--receipt-feed-mm', `${layout.feedMm}mm`);
}

function clearPrintDocumentAttrs() {
  const root = document.documentElement;
  root.removeAttribute('data-receipt-paper');
  root.removeAttribute('data-receipt-profile');
  root.style.removeProperty('--receipt-paper-mm');
  root.style.removeProperty('--receipt-printable-mm');
  root.style.removeProperty('--receipt-font-px');
  root.style.removeProperty('--receipt-line-height');
  root.style.removeProperty('--receipt-feed-mm');
}

export function printReceipt(delayMs = 400) {
  const layout = resolvePrintLayout();
  applyPrintDocumentAttrs(layout);

  return new Promise<void>((resolve) => {
    const cleanup = () => {
      clearPrintDocumentAttrs();
      resolve();
    };
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

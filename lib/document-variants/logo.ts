/** Sumber logo dokumen: data URL tersimpan, atau URL file jika base64 tidak di-inline. */

export function resolveDocLogo(source: unknown): string | undefined {
  const s = source as {
    showLogoOnInvoice?: boolean;
    logoBase64?: string;
    logoUrl?: string;
    vendorLogoBase64?: string;
  } | null | undefined;
  if (!s || s.showLogoOnInvoice === false) return undefined;
  const src = String(s.logoBase64 || s.logoUrl || s.vendorLogoBase64 || '').trim();
  return src || undefined;
}

export function pdfEmbeddableLogo(source: unknown): string | undefined {
  const src = resolveDocLogo(source);
  if (!src) return undefined;
  if (src.startsWith('data:image/')) return src;
  return undefined;
}

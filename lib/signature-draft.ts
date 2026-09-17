/** Draft signature (Nama / Jabatan / NIK) — dipakai GRN Penerima & hutang Mengetahui. */

export type SignatureDraft = {
  userName: string;
  jabatan: string;
  nik: string;
};

export const GRN_RECEIVER_SIG_KEY = 'grn-receiver-signature';
export const HUTANG_KNOWING_SIG_KEY = 'hutang-knowing-signature';

export function emptySignatureDraft(): SignatureDraft {
  return { userName: '', jabatan: '', nik: '' };
}

export function loadSignatureDraft(storageKey: string): SignatureDraft {
  if (typeof window === 'undefined') return emptySignatureDraft();
  try {
    const raw = localStorage.getItem(storageKey);
    if (!raw) return emptySignatureDraft();
    const parsed = JSON.parse(raw) as Partial<SignatureDraft>;
    return {
      userName: String(parsed.userName || ''),
      jabatan: String(parsed.jabatan || ''),
      nik: String(parsed.nik || ''),
    };
  } catch {
    return emptySignatureDraft();
  }
}

export function saveSignatureDraft(storageKey: string, sig: SignatureDraft) {
  try {
    localStorage.setItem(storageKey, JSON.stringify({
      userName: sig.userName.trim(),
      jabatan: sig.jabatan.trim(),
      nik: sig.nik.trim(),
    }));
  } catch {
    /* ignore quota */
  }
}

export function isSignatureDraftReady(sig: SignatureDraft | null | undefined): boolean {
  return Boolean(sig?.userName?.trim() && sig?.nik?.trim());
}

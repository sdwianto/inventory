/**
 * Pengaturan cetak struk (per browser / per mesin).
 * Default: Epson TM-U220 — impact dot matrix, roll 76–80 mm.
 */

export const PRINTER_PROFILES = {
  'epson-tm-u220': {
    id: 'epson-tm-u220',
    label: 'Epson TM-U220 (impact 76 mm)',
    driverHint: 'Epson TM-U220',
    paperWidthMm: 80,
    printableWidthMm: 76,
    fontSizePx: 12,
    lineHeight: 1.4,
    feedMm: 14,
    showLogoOnPrint: false,
    charsPerLine: 42,
  },
  'thermal-80': {
    id: 'thermal-80',
    label: 'Thermal 80 mm (ESC/POS)',
    driverHint: 'Generic / POS-80',
    paperWidthMm: 80,
    printableWidthMm: 72,
    fontSizePx: 11,
    lineHeight: 1.35,
    feedMm: 8,
    showLogoOnPrint: true,
    charsPerLine: 48,
  },
  'thermal-58': {
    id: 'thermal-58',
    label: 'Thermal 58 mm',
    driverHint: 'POS-58',
    paperWidthMm: 58,
    printableWidthMm: 48,
    fontSizePx: 10,
    lineHeight: 1.3,
    feedMm: 6,
    showLogoOnPrint: true,
    charsPerLine: 32,
  },
};

const STORAGE_KEY = 'dawam_printer_settings_v1';

export const DEFAULT_PRINTER_SETTINGS = {
  profileId: 'epson-tm-u220',
  /** Override logo saat cetak (null = ikut profil + tenant) */
  showLogoOnPrint: null,
  /** Tambahan jarak kosong di bawah struk (mm) — untuk tear/cut */
  extraFeedMm: 0,
};

export function getPrinterProfile(settings) {
  const id = settings?.profileId || DEFAULT_PRINTER_SETTINGS.profileId;
  return PRINTER_PROFILES[id] || PRINTER_PROFILES['epson-tm-u220'];
}

export function getPrinterSettings() {
  if (typeof window === 'undefined') {
    return { ...DEFAULT_PRINTER_SETTINGS };
  }
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_PRINTER_SETTINGS };
    return { ...DEFAULT_PRINTER_SETTINGS, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULT_PRINTER_SETTINGS };
  }
}

export function savePrinterSettings(partial) {
  const next = { ...getPrinterSettings(), ...partial };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  return next;
}

/** Gabungkan profil + preferensi untuk komponen Receipt & CSS print. */
export function resolvePrintLayout(settings = getPrinterSettings()) {
  const profile = getPrinterProfile(settings);
  const showLogo =
    settings.showLogoOnPrint !== null && settings.showLogoOnPrint !== undefined
      ? settings.showLogoOnPrint
      : profile.showLogoOnPrint;
  const feedMm = profile.feedMm + (Number(settings.extraFeedMm) || 0);
  const narrow = profile.paperWidthMm <= 58;
  return {
    profile,
    paperWidthMm: profile.paperWidthMm,
    printableWidthMm: profile.printableWidthMm,
    fontSizePx: profile.fontSizePx,
    lineHeight: profile.lineHeight,
    feedMm,
    showLogoOnPrint: showLogo,
    narrow,
    charsPerLine: profile.charsPerLine,
    profileId: profile.id,
  };
}

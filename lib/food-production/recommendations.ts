/**
 * AI Recommendation — ADR-001 Phase 3 (Sprint 18).
 * Deterministic ERP rules — NOT a chatbot. Simple for Kitchen / Powerful for Management.
 */

import { roundQty } from '@/lib/food-production/material-requirement';
import type { ForecastLine } from '@/lib/food-production/forecast';

export type RecType =
  | 'MENU_ALT'
  | 'CHEAPER_SUPPLY'
  | 'SUBSTITUTE'
  | 'STOCK_OPT'
  | 'SHORTAGE'
  | 'WASTE';

export type RecSeverity = 'info' | 'warn' | 'critical';
export type RecAudience = 'kitchen' | 'management' | 'both';

export interface FoodRecommendation {
  id: string;
  type: RecType;
  severity: RecSeverity;
  title: string;
  detail: string;
  audience: RecAudience;
  href?: string;
  evidence?: Record<string, string | number>;
  actions?: { label: string; href: string }[];
}

export interface RecommendationsSnapshot {
  generatedAt: string;
  horizon: number;
  items: FoodRecommendation[];
  summary: {
    total: number;
    critical: number;
    byType: Partial<Record<RecType, number>>;
  };
}

export const REC_TYPE_LABELS: Record<RecType, string> = {
  MENU_ALT: 'Menu alternatif',
  CHEAPER_SUPPLY: 'Harga / supply',
  SUBSTITUTE: 'Pengganti bahan',
  STOCK_OPT: 'Optimasi stok',
  SHORTAGE: 'Prediksi shortage',
  WASTE: 'Deteksi boros',
};

export const WASTE_ISSUE_OVERAGE_PCT = 15;
export const WASTE_PORSI_PCT = 10;
export const STOCK_OVERSTOCK_DAYS = 21;
export const CHEAPER_SUPPLY_PCT = 8;

function sortRecs(items: FoodRecommendation[]): FoodRecommendation[] {
  const rank: Record<RecSeverity, number> = { critical: 0, warn: 1, info: 2 };
  return [...items].sort((a, b) => rank[a.severity] - rank[b.severity] || a.type.localeCompare(b.type));
}

function summarize(items: FoodRecommendation[]): RecommendationsSnapshot['summary'] {
  const byType: Partial<Record<RecType, number>> = {};
  let critical = 0;
  for (const it of items) {
    byType[it.type] = (byType[it.type] || 0) + 1;
    if (it.severity === 'critical') critical += 1;
  }
  return { total: items.length, critical, byType };
}

/** SHORTAGE — forecast SHORT lines → actionable buy/MRP tips. */
export function recommendShortages(lines: ForecastLine[]): FoodRecommendation[] {
  const out: FoodRecommendation[] = [];
  for (const line of lines) {
    if (line.risk !== 'SHORT') continue;
    const name = line.productNama || line.productKode || line.productId;
    out.push({
      id: `shortage-${line.productId}`,
      type: 'SHORTAGE',
      severity: 'critical',
      title: `Shortage: ${name}`,
      detail: `On-hand ${roundQty(line.onHandQty)} vs forecast ${roundQty(line.forecastQty)} — kekurangan ~${roundQty(line.projectedShortage)}.`,
      audience: 'both',
      href: '/food-production/purchase-requirement',
      evidence: {
        productId: line.productId,
        onHand: roundQty(line.onHandQty),
        forecast: roundQty(line.forecastQty),
        shortage: roundQty(line.projectedShortage),
      },
      actions: [
        { label: 'Forecast', href: '/food-production/forecast' },
        { label: 'Kebutuhan beli', href: '/food-production/purchase-requirement' },
      ],
    });
  }
  return out;
}

/** WASTE — over-issue PBL and waste porsi HSL above thresholds. */
export function recommendWaste(input: {
  issueLines: Array<{
    issueNo?: string;
    productId: string;
    productNama?: string;
    qtyPlanned: number;
    qtyIssued: number;
  }>;
  resultLines: Array<{
    resultNo?: string;
    menuKode?: string;
    finishedGoodNama?: string;
    targetPorsi: number;
    wastePorsi: number;
  }>;
}): FoodRecommendation[] {
  const out: FoodRecommendation[] = [];
  for (const line of input.issueLines) {
    const planned = Number(line.qtyPlanned) || 0;
    const issued = Number(line.qtyIssued) || 0;
    if (!(planned > 0) || !(issued > planned)) continue;
    const overPct = Math.round(((issued - planned) / planned) * 100);
    if (overPct < WASTE_ISSUE_OVERAGE_PCT) continue;
    const name = line.productNama || line.productId;
    out.push({
      id: `waste-issue-${line.productId}-${line.issueNo || 'x'}`,
      type: 'WASTE',
      severity: overPct >= 30 ? 'critical' : 'warn',
      title: `Boros bahan: ${name} (+${overPct}%)`,
      detail: `PBL ${line.issueNo || ''} mengeluarkan ${roundQty(issued)} vs rencana ${roundQty(planned)}.`,
      audience: 'kitchen',
      href: '/food-production/issue',
      evidence: { qtyPlanned: planned, qtyIssued: issued, overPct },
      actions: [{ label: 'Pengambilan bahan', href: '/food-production/issue' }],
    });
  }
  for (const line of input.resultLines) {
    const target = Number(line.targetPorsi) || 0;
    const waste = Number(line.wastePorsi) || 0;
    if (!(target > 0) || !(waste > 0)) continue;
    const wastePct = Math.round((waste / target) * 100);
    if (wastePct < WASTE_PORSI_PCT) continue;
    const name = line.finishedGoodNama || line.menuKode || 'FG';
    out.push({
      id: `waste-result-${line.resultNo || 'x'}-${name}`,
      type: 'WASTE',
      severity: wastePct >= 20 ? 'critical' : 'warn',
      title: `Waste porsi: ${name} (${wastePct}%)`,
      detail: `HSL ${line.resultNo || ''} waste ${roundQty(waste)} dari target ${roundQty(target)} porsi.`,
      audience: 'both',
      href: '/food-production/result',
      evidence: { targetPorsi: target, wastePorsi: waste, wastePct },
      actions: [
        { label: 'Hasil produksi', href: '/food-production/result' },
        { label: 'Biaya', href: '/food-production/cost' },
      ],
    });
  }
  return out;
}

/** STOCK_OPT — overstock (many days cover) vs SHORT already handled separately. */
export function recommendStockOpt(lines: ForecastLine[]): FoodRecommendation[] {
  const out: FoodRecommendation[] = [];
  for (const line of lines) {
    if (line.risk === 'SHORT') continue;
    const avgDaily = Number(line.avgDailyQty) || 0;
    const onHand = Number(line.onHandQty) || 0;
    if (!(avgDaily > 0) || !(onHand > 0)) continue;
    const daysCover = onHand / avgDaily;
    if (daysCover < STOCK_OVERSTOCK_DAYS) continue;
    const name = line.productNama || line.productKode || line.productId;
    out.push({
      id: `stock-opt-${line.productId}`,
      type: 'STOCK_OPT',
      severity: 'info',
      title: `Overstock: ${name} (~${Math.round(daysCover)} hari)`,
      detail: `Tunda pembelian; prioritaskan pakai stok on-hand ${roundQty(onHand)}.`,
      audience: 'management',
      href: '/food-production/forecast',
      evidence: {
        onHand: roundQty(onHand),
        avgDaily: roundQty(avgDaily),
        daysCover: Math.round(daysCover),
      },
      actions: [
        { label: 'Forecast', href: '/food-production/forecast' },
        { label: 'Saldo stok', href: '/stok/saldo' },
      ],
    });
  }
  return out;
}

export interface SubstituteCandidate {
  productId: string;
  productKode?: string;
  productNama?: string;
  hargaBeli?: number;
  onHandQty?: number;
  grup?: string;
}

/** SUBSTITUTE — for shortage products, suggest same grup / cheaper with stock. */
export function recommendSubstitutes(input: {
  shortageProductIds: string[];
  products: Map<string, SubstituteCandidate>;
}): FoodRecommendation[] {
  const out: FoodRecommendation[] = [];
  const byGrup = new Map<string, SubstituteCandidate[]>();
  for (const p of input.products.values()) {
    const g = String(p.grup || '').trim();
    if (!g) continue;
    const list = byGrup.get(g) || [];
    list.push(p);
    byGrup.set(g, list);
  }

  for (const shortId of input.shortageProductIds) {
    const short = input.products.get(shortId);
    if (!short) continue;
    const grup = String(short.grup || '').trim();
    if (!grup) continue;
    const peers = (byGrup.get(grup) || [])
      .filter((p) => p.productId !== shortId && (Number(p.onHandQty) || 0) > 0)
      .sort((a, b) => (Number(a.hargaBeli) || 1e12) - (Number(b.hargaBeli) || 1e12));
    const alt = peers[0];
    if (!alt) continue;
    const shortName = short.productNama || short.productKode || shortId;
    const altName = alt.productNama || alt.productKode || alt.productId;
    out.push({
      id: `sub-${shortId}-${alt.productId}`,
      type: 'SUBSTITUTE',
      severity: 'warn',
      title: `Pengganti untuk ${shortName}`,
      detail: `Coba ${altName} (grup ${grup}, on-hand ${roundQty(Number(alt.onHandQty) || 0)}, harga ${Number(alt.hargaBeli) || 0}).`,
      audience: 'kitchen',
      href: '/food-production/recipe',
      evidence: {
        shortProductId: shortId,
        altProductId: alt.productId,
        grup,
        altOnHand: roundQty(Number(alt.onHandQty) || 0),
        altHarga: Number(alt.hargaBeli) || 0,
      },
      actions: [
        { label: 'Resep', href: '/food-production/recipe' },
        { label: 'MRP', href: '/food-production/mrp' },
      ],
    });
  }
  return out;
}

export interface MenuAltCandidate {
  menuId: string;
  menuKode?: string;
  menuNama?: string;
  targetCostPerPorsi?: number;
  aktif?: boolean;
}

/** MENU_ALT — when a planned menu is costly or shortage-heavy, suggest cheaper aktif menu. */
export function recommendMenuAlt(input: {
  plannedMenus: Array<{ menuId: string; menuNama?: string; estimatedCostPerPorsi?: number }>;
  activeMenus: MenuAltCandidate[];
}): FoodRecommendation[] {
  const out: FoodRecommendation[] = [];
  const sorted = [...input.activeMenus]
    .filter((m) => m.aktif !== false && Number(m.targetCostPerPorsi) > 0)
    .sort((a, b) => (Number(a.targetCostPerPorsi) || 0) - (Number(b.targetCostPerPorsi) || 0));

  for (const planned of input.plannedMenus) {
    const cost = Number(planned.estimatedCostPerPorsi) || 0;
    if (!(cost > 0)) continue;
    const cheaper = sorted.find(
      (m) => m.menuId !== planned.menuId && (Number(m.targetCostPerPorsi) || 0) < cost * 0.9,
    );
    if (!cheaper) continue;
    const savePct = Math.round((1 - (Number(cheaper.targetCostPerPorsi) || 0) / cost) * 100);
    if (savePct < 5) continue;
    out.push({
      id: `menu-alt-${planned.menuId}-${cheaper.menuId}`,
      type: 'MENU_ALT',
      severity: 'info',
      title: `Menu alternatif lebih hemat: ${cheaper.menuNama || cheaper.menuKode}`,
      detail: `Ganti ${planned.menuNama || planned.menuId} — potensi hemat ~${savePct}% per porsi (target cost).`,
      audience: 'management',
      href: '/food-production/menu',
      evidence: {
        fromMenuId: planned.menuId,
        toMenuId: cheaper.menuId,
        fromCost: roundQty(cost),
        toCost: roundQty(Number(cheaper.targetCostPerPorsi) || 0),
        savePct,
      },
      actions: [
        { label: 'Menu', href: '/food-production/menu' },
        { label: 'Rencana', href: '/food-production/plan' },
      ],
    });
  }
  return out;
}

/** CHEAPER_SUPPLY — master hargaBeli above supplier book and/or last GRN. */
export function recommendCheaperSupply(input: {
  products: Array<{
    productId: string;
    productNama?: string;
    productKode?: string;
    hargaBeli: number;
    lastReceiptUnitPrice?: number;
    bestBookPrice?: number;
    bestBookSupplierId?: string;
    bestBookSupplierNama?: string;
  }>;
}): FoodRecommendation[] {
  const out: FoodRecommendation[] = [];
  for (const p of input.products) {
    const master = Number(p.hargaBeli) || 0;
    if (!(master > 0)) continue;

    const book = Number(p.bestBookPrice) || 0;
    const last = Number(p.lastReceiptUnitPrice) || 0;

    type Signal = {
      compare: number;
      source: 'book' | 'grn';
      pct: number;
      supplierNama?: string;
    };
    const signals: Signal[] = [];
    if (book > 0 && master > book) {
      const pct = Math.round(((master - book) / book) * 100);
      if (pct >= CHEAPER_SUPPLY_PCT) {
        signals.push({
          compare: book,
          source: 'book',
          pct,
          supplierNama: p.bestBookSupplierNama,
        });
      }
    }
    if (last > 0 && master > last) {
      const pct = Math.round(((master - last) / last) * 100);
      if (pct >= CHEAPER_SUPPLY_PCT) {
        signals.push({ compare: last, source: 'grn', pct });
      }
    }
    if (!signals.length) continue;

    // Prefer price-book signal when present; else highest savings.
    signals.sort((a, b) => {
      if (a.source === 'book' && b.source !== 'book') return -1;
      if (b.source === 'book' && a.source !== 'book') return 1;
      return b.pct - a.pct;
    });
    const top = signals[0];
    const name = p.productNama || p.productKode || p.productId;
    const compareLabel = top.source === 'book'
      ? `price book ${top.supplierNama || p.bestBookSupplierId || 'supplier'} ${roundQty(top.compare)}`
      : `GRN terakhir ${roundQty(top.compare)}`;

    out.push({
      id: `cheap-${p.productId}-${top.source}`,
      type: 'CHEAPER_SUPPLY',
      severity: top.pct >= 20 ? 'warn' : 'info',
      title: `Harga master lebih tinggi: ${name} (+${top.pct}%)`,
      detail: `hargaBeli ${roundQty(master)} vs ${compareLabel} — review master / supplier.`,
      audience: 'management',
      href: top.source === 'book' ? '/food-production/price-book' : '/produk',
      evidence: {
        productId: p.productId,
        hargaBeli: roundQty(master),
        comparePrice: roundQty(top.compare),
        source: top.source,
        lastReceipt: last > 0 ? roundQty(last) : undefined,
        bestBookPrice: book > 0 ? roundQty(book) : undefined,
        supplierId: p.bestBookSupplierId,
        supplierNama: p.bestBookSupplierNama,
        pct: top.pct,
      },
      actions: [
        { label: 'Price book', href: '/food-production/price-book' },
        { label: 'Produk', href: '/produk' },
        { label: 'Penerimaan', href: '/penerimaan' },
      ],
    });
  }
  return out;
}

export function buildRecommendations(input: {
  horizon: number;
  forecastLines: ForecastLine[];
  issueWasteLines: Parameters<typeof recommendWaste>[0]['issueLines'];
  resultWasteLines: Parameters<typeof recommendWaste>[0]['resultLines'];
  products: Map<string, SubstituteCandidate>;
  plannedMenus: Parameters<typeof recommendMenuAlt>[0]['plannedMenus'];
  activeMenus: MenuAltCandidate[];
  cheaperSupply: Parameters<typeof recommendCheaperSupply>[0]['products'];
  types?: RecType[];
  audience?: RecAudience | 'all';
}): RecommendationsSnapshot {
  const allow = input.types?.length ? new Set(input.types) : null;
  const shortIds = input.forecastLines.filter((l) => l.risk === 'SHORT').map((l) => l.productId);

  let items: FoodRecommendation[] = [
    ...recommendShortages(input.forecastLines),
    ...recommendWaste({ issueLines: input.issueWasteLines, resultLines: input.resultWasteLines }),
    ...recommendStockOpt(input.forecastLines),
    ...recommendSubstitutes({ shortageProductIds: shortIds, products: input.products }),
    ...recommendMenuAlt({ plannedMenus: input.plannedMenus, activeMenus: input.activeMenus }),
    ...recommendCheaperSupply({ products: input.cheaperSupply }),
  ];

  if (allow) items = items.filter((i) => allow.has(i.type));
  if (input.audience && input.audience !== 'all') {
    const aud = input.audience;
    items = items.filter((i) => i.audience === aud || i.audience === 'both');
  }

  items = sortRecs(items);
  if (!items.length) {
    items = [{
      id: 'all-clear',
      type: 'STOCK_OPT',
      severity: 'info',
      title: 'Tidak ada rekomendasi aktif',
      detail: 'Operasi & data FP tampak sehat menurut aturan saat ini.',
      audience: 'both',
      href: '/food-production/dashboard',
    }];
  }

  return {
    generatedAt: new Date().toISOString(),
    horizon: input.horizon,
    items,
    summary: summarize(items.filter((i) => i.id !== 'all-clear')),
  };
}

export function parseRecTypes(raw: string | null): RecType[] | undefined {
  if (!raw?.trim()) return undefined;
  const allowed = new Set<string>(Object.keys(REC_TYPE_LABELS));
  const types = raw.split(',').map((s) => s.trim().toUpperCase()).filter((s) => allowed.has(s)) as RecType[];
  return types.length ? types : undefined;
}

/**
 * Delivery — Sprint 5.2 (docs/migration/FOOD-PRODUCTION-DOMAIN-SPLIT.md).
 * Rute pengiriman (loading → armada → stop → drop) dibangun dari snapshot DispatchLine
 * (servicePointId, qtyPorsi, ...) milik domain Inventory — direferensikan, tidak mewarisi
 * struktur Dispatch. Masih dalam satu dokumen/collection distribution_orders
 * (DispatchDoc.loadings / DispatchDoc.armadas); pemisahan storage/collection adalah migrasi
 * terpisah, di luar scope langkah ini.
 */

import { roundQty } from '@/lib/food-production/material-requirement';
import {
  KATEGORI_PORSI_OPTIONS,
  compareJamKirim,
  normalizeJamKirim,
  routeJamKirim,
  type ServicePointPorsiByKategori,
} from '@/lib/food-production/service-point';
import { scalePorsiByKategoriForQty, type DispatchLine } from '@/lib/food-production/distribution';

/** Jam pengiriman dalam satu stop (snapshot dari master titik.drops). */
export interface DeliveryStopDrop {
  dropId: string;
  /** Jam pengiriman (HH:mm). */
  jamKirim?: string;
  /** Keterangan singkat opsional. */
  label?: string;
  qtyPorsi: number;
  porsiByKategori?: ServicePointPorsiByKategori;
}

/** Satu stop dalam rute armada (urut jam drop / jam pengiriman). */
export interface DeliveryArmadaStop {
  urutan: number;
  servicePointId: string;
  servicePointKode?: string;
  servicePointNama?: string;
  jamKirim?: string;
  kapasitasPorsi?: number;
  qtyPorsi: number;
  porsiByKategori?: ServicePointPorsiByKategori;
  drops?: DeliveryStopDrop[];
}

/** Armada + rute + ringkasan kategori porsi pada dokumen DST. */
export interface DeliveryArmada {
  armadaId: string;
  armadaKode?: string;
  armadaNama?: string;
  platNomor?: string;
  kapasitasPorsi?: number;
  stops: DeliveryArmadaStop[];
  porsiByKategori: ServicePointPorsiByKategori;
  qtyPorsiTotal: number;
  servicePointCount: number;
}

/** Gelombang loading (start/max) berisi satu atau lebih armada. */
export interface DeliveryLoading {
  urutan: number;
  label?: string;
  jamStart: string;
  jamMax: string;
  armadas: DeliveryArmada[];
  qtyPorsiTotal: number;
  servicePointCount: number;
}

/** Kompatibel mundur: loadings, atau wrap armadas legacy jadi 1 loading. */
export function resolveDeliveryLoadings(doc: {
  loadings?: DeliveryLoading[] | null;
  armadas?: DeliveryArmada[] | null;
}): DeliveryLoading[] {
  if (doc.loadings?.length) return doc.loadings;
  if (doc.armadas?.length) {
    return [{
      urutan: 1,
      label: 'Loading 1',
      jamStart: '00:00',
      jamMax: '00:00',
      armadas: doc.armadas,
      qtyPorsiTotal: roundQty(doc.armadas.reduce((s, a) => s + (Number(a.qtyPorsiTotal) || 0), 0)),
      servicePointCount: doc.armadas.reduce((s, a) => s + (Number(a.servicePointCount) || 0), 0),
    }];
  }
  return [];
}

export function deliveryLoadingLabel(urutan: number, label?: string): string {
  if (label?.trim()) return label.trim();
  const names = ['pertama', 'kedua', 'ketiga', 'keempat', 'kelima'];
  const n = names[urutan - 1];
  return n ? `Loading ${n}` : `Loading ${urutan}`;
}

/** Split qty/kategori proporsional ke jam pengiriman (by qtyHint atau equal). */
export function splitStopIntoDrops(input: {
  qtyPorsi: number;
  porsiByKategori?: ServicePointPorsiByKategori;
  drops: Array<{ dropId: string; jamKirim?: string; label?: string; qtyHint?: number }>;
}): DeliveryStopDrop[] {
  const drops = input.drops || [];
  if (!drops.length) return [];
  const total = Math.round(Number(input.qtyPorsi) || 0);
  if (!(total > 0)) return [];
  const weights = drops.map((d) => {
    const h = Number(d.qtyHint);
    return Number.isFinite(h) && h > 0 ? h : 1;
  });
  const wSum = weights.reduce((s, w) => s + w, 0) || drops.length;
  const qtys: number[] = new Array(drops.length).fill(0);
  let allocated = 0;
  for (let i = 0; i < drops.length - 1; i++) {
    const q = Math.max(0, Math.round((total * weights[i]) / wSum));
    qtys[i] = q;
    allocated += q;
  }
  qtys[drops.length - 1] = Math.max(0, total - allocated);

  return drops.map((d, i) => ({
    dropId: d.dropId,
    jamKirim: d.jamKirim,
    label: d.label?.trim() || undefined,
    qtyPorsi: qtys[i],
    porsiByKategori: scalePorsiByKategoriForQty(
      input.porsiByKategori,
      qtys[i],
      total,
    ),
  })).filter((d) => d.qtyPorsi > 0);
}

export function sumPorsiByKategoriMaps(
  maps: Array<ServicePointPorsiByKategori | null | undefined>,
): ServicePointPorsiByKategori {
  const out: ServicePointPorsiByKategori = {};
  for (const map of maps) {
    if (!map) continue;
    for (const opt of KATEGORI_PORSI_OPTIONS) {
      const n = Number(map[opt.value]) || 0;
      if (n > 0) out[opt.value] = (Number(out[opt.value]) || 0) + n;
    }
  }
  return out;
}

export type DeliveryArmadaAssignmentInput = {
  armadaId: string;
  armadaKode?: string;
  armadaNama?: string;
  platNomor?: string;
  kapasitasPorsi?: number;
  servicePointIds: string[];
  /** Opsional: override jam pengiriman per titik. */
  stopDrops?: Record<string, Array<{
    dropId: string;
    jamKirim?: string;
    label?: string;
    qtyHint?: number;
    qtyPorsi?: number;
  }>>;
};

export type DeliveryLoadingInput = {
  urutan?: number;
  label?: string;
  jamStart: string;
  jamMax: string;
  armadas: DeliveryArmadaAssignmentInput[];
};

/**
 * Bangun gelombang loading + armada + rute jam makan.
 * Setiap titik alokasi harus masuk tepat satu armada (lintas loading).
 */
export function buildDeliveryLoadings(input: {
  loadings: DeliveryLoadingInput[];
  lines: DispatchLine[];
  /** Master jam pengiriman per servicePointId (fallback bila stopDrops tidak dikirim). */
  dropsByServicePointId?: Record<string, Array<{
    dropId: string;
    jamKirim?: string;
    label?: string;
    qtyHint?: number;
    qtyPorsi?: number;
  }>>;
}): { loadings: DeliveryLoading[]; armadas: DeliveryArmada[]; lines: DispatchLine[] } | { error: string } {
  const rawLoadings = input.loadings || [];
  if (!rawLoadings.length) return { error: 'Minimal satu gelombang loading wajib' };

  const qtyBySp = new Map<string, number>();
  const metaBySp = new Map<string, DispatchLine>();
  for (const line of input.lines || []) {
    const id = String(line.servicePointId || '').trim();
    if (!id) continue;
    qtyBySp.set(id, roundQty((qtyBySp.get(id) || 0) + (Number(line.qtyPorsi) || 0)));
    if (!metaBySp.has(id)) metaBySp.set(id, line);
  }
  const allSpIds = [...qtyBySp.keys()];
  if (!allSpIds.length) return { error: 'Tidak ada titik untuk dirute' };

  const claimed = new Map<string, string>();
  const loadings: DeliveryLoading[] = [];
  const flatArmadas: DeliveryArmada[] = [];

  for (let li = 0; li < rawLoadings.length; li++) {
    const L = rawLoadings[li];
    const urutan = Number(L.urutan) > 0 ? Math.round(Number(L.urutan)) : li + 1;
    const jamStart = normalizeJamKirim(L.jamStart);
    if (jamStart && typeof jamStart === 'object' && 'error' in jamStart) {
      return { error: `Loading ${urutan}: ${jamStart.error}` };
    }
    const jamMax = normalizeJamKirim(L.jamMax);
    if (jamMax && typeof jamMax === 'object' && 'error' in jamMax) {
      return { error: `Loading ${urutan}: ${jamMax.error}` };
    }
    if (!jamStart || !jamMax) {
      return { error: `Loading ${urutan}: jamStart dan jamMax wajib` };
    }
    if (compareJamKirim(jamStart, jamMax) > 0) {
      return { error: `Loading ${urutan}: jamStart tidak boleh setelah jamMax` };
    }
    if (!L.armadas?.length) {
      return { error: `Loading ${urutan}: minimal satu armada` };
    }

    const armadas: DeliveryArmada[] = [];
    for (const asg of L.armadas) {
      const armadaId = String(asg.armadaId || '').trim();
      if (!armadaId) return { error: `Loading ${urutan}: armadaId wajib` };
      const ids = [...new Set((asg.servicePointIds || []).map((x) => String(x || '').trim()).filter(Boolean))];
      if (!ids.length) {
        return { error: `Armada ${asg.armadaNama || asg.armadaKode || armadaId}: pilih minimal satu titik` };
      }

      for (const spId of ids) {
        if (!qtyBySp.has(spId)) {
          return { error: `Titik ${spId} tidak ada di alokasi packing` };
        }
        if (claimed.has(spId)) {
          return { error: 'Titik tidak boleh masuk lebih dari satu armada / loading' };
        }
        claimed.set(spId, armadaId);
      }

      const stopsRaw = ids.map((spId) => {
        const meta = metaBySp.get(spId)!;
        const qtyPorsi = qtyBySp.get(spId) || 0;
        const porsiByKategori = meta.porsiByKategori;
        const dropSrc = asg.stopDrops?.[spId]
          || input.dropsByServicePointId?.[spId]
          || [];
        const drops = dropSrc.length
          ? (() => {
            const withExplicit = dropSrc.every((d) => Number(d.qtyPorsi) > 0);
            const built = withExplicit
              ? dropSrc.map((d) => ({
                dropId: d.dropId,
                label: d.label,
                jamKirim: d.jamKirim,
                qtyPorsi: Math.round(Number(d.qtyPorsi) || 0),
                porsiByKategori: scalePorsiByKategoriForQty(
                  porsiByKategori,
                  Math.round(Number(d.qtyPorsi) || 0),
                  qtyPorsi,
                ),
              })).filter((d) => d.qtyPorsi > 0)
              : splitStopIntoDrops({
                qtyPorsi,
                porsiByKategori,
                drops: dropSrc.map((d) => ({
                  dropId: d.dropId,
                  label: d.label,
                  jamKirim: d.jamKirim,
                  qtyHint: d.qtyHint,
                })),
              });
            return [...built].sort((a, b) => compareJamKirim(a.jamKirim, b.jamKirim));
          })()
          : undefined;
        const jamKirim = routeJamKirim({ jamKirim: meta.jamKirim, drops });
        return {
          servicePointId: spId,
          servicePointKode: meta.servicePointKode,
          servicePointNama: meta.servicePointNama,
          jamKirim,
          kapasitasPorsi: meta.kapasitasPorsi,
          qtyPorsi,
          porsiByKategori,
          drops,
        };
      }).sort((a, b) => {
        const byJam = compareJamKirim(a.jamKirim, b.jamKirim);
        if (byJam !== 0) return byJam;
        return String(a.servicePointNama || a.servicePointId)
          .localeCompare(String(b.servicePointNama || b.servicePointId), 'id');
      });

      const stops: DeliveryArmadaStop[] = stopsRaw.map((s, idx) => ({
        urutan: idx + 1,
        ...s,
      }));
      const porsiByKategori = sumPorsiByKategoriMaps(stops.map((s) => s.porsiByKategori));
      const qtyPorsiTotal = roundQty(stops.reduce((s, x) => s + (Number(x.qtyPorsi) || 0), 0));
      const armada: DeliveryArmada = {
        armadaId,
        armadaKode: asg.armadaKode,
        armadaNama: asg.armadaNama,
        platNomor: asg.platNomor,
        kapasitasPorsi: asg.kapasitasPorsi,
        stops,
        porsiByKategori,
        qtyPorsiTotal,
        servicePointCount: stops.length,
      };
      armadas.push(armada);
      flatArmadas.push(armada);
    }

    loadings.push({
      urutan,
      label: L.label?.trim() || deliveryLoadingLabel(urutan),
      jamStart,
      jamMax,
      armadas,
      qtyPorsiTotal: roundQty(armadas.reduce((s, a) => s + a.qtyPorsiTotal, 0)),
      servicePointCount: armadas.reduce((s, a) => s + a.servicePointCount, 0),
    });
  }

  for (const spId of allSpIds) {
    if (!claimed.has(spId)) {
      const meta = metaBySp.get(spId);
      const label = meta?.servicePointNama || meta?.servicePointKode || spId;
      return { error: `Titik "${label}" belum di-assign ke armada` };
    }
  }

  const lines = (input.lines || []).map((l) => ({
    ...l,
    armadaId: claimed.get(l.servicePointId),
  }));

  return { loadings, armadas: flatArmadas, lines };
}

/** Legacy helper — wrap ke satu loading default. */
export function buildDeliveryArmadas(input: {
  assignments: DeliveryArmadaAssignmentInput[];
  lines: DispatchLine[];
}): { armadas: DeliveryArmada[]; lines: DispatchLine[] } | { error: string } {
  const built = buildDeliveryLoadings({
    loadings: [{
      urutan: 1,
      label: 'Loading 1',
      jamStart: '00:00',
      jamMax: '00:00',
      armadas: input.assignments,
    }],
    lines: input.lines,
  });
  if ('error' in built) return built;
  return { armadas: built.armadas, lines: built.lines };
}

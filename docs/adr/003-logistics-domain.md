# ADR-003: Logistics Domain

**Status:** ACCEPTED  
**Tanggal:** 2026-07-28  
**Owner:** Inventory Domain / Product Architecture  
**App host:** Inventory App  
**Relates:** ADR-001 (Food Production — Dispatch tetap di sana), ADR-002 (Kitchen Assurance — domain terpisah, tidak berubah oleh ADR ini)

---

## Prinsip

> Logistics owns getting food **from the kitchen's dispatch point to the destination** — the vehicle, the route, the schedule, and who is allowed to execute delivery status. It does not own how much food is dispatched, or what is being cooked.

Logistics lahir bukan dari desain awal, tapi dari pemisahan (`docs/migration/FOOD-PRODUCTION-DOMAIN-SPLIT.md`, Sprint 1–5, selesai 2026-07-28) setelah audit dependensi membuktikan bahwa Armada, rute pengiriman (loading/stop/drop), dan peran Driver tidak punya keterkaitan teknis dengan logika FEFO/Dispatch — hanya bersinggungan lewat referensi `DispatchLine` (snapshot data, bukan pewarisan struktur).

```
Food Production (Dispatch)
       |  DispatchLine snapshot (qty, tujuan, kategori porsi)
       v
   Logistics (Delivery)
       |
       v
Barang sampai ke titik layanan
```

---

## Kenapa domain terpisah (bukan sekadar folder)

Audit yang mendahului keputusan ini (dicatat lengkap di dokumen migrasi) membuktikan, bukan mengasumsikan:

- 3 script FEFO (`dist-fefo-ship.ts`, `dist-fefo-shortfall-reconcile.ts`, `dist-return-fefo-shortfall-reconcile.ts`) — **nol referensi** ke armada/route/stop/driver. FEFO murni bergantung pada `lot, qty, destination` (konsep Dispatch), bukan konsep Logistics.
- `DispatchDoc.loadings`/`.armadas` (rute/jam/armada) secara struktural berbeda dari `DispatchDoc.lines`/`fefoConsume`/`fefoRestore` (barang keluar gudang) — dua konsep yang sebelumnya bercampur dalam satu dokumen (`distribution_orders`), didokumentasikan sebagai *mental model* di Sprint 4 sebelum dipisah fisik di Sprint 5.2.
- Role `DRIVER` secara operasional hanya butuh: lihat Titik Layanan (baca) + ubah status pengiriman (dikirim/selesai) — tidak butuh akses penuh Dispatch (create/edit/cancel dokumen).

Kesimpulan: Logistics memenuhi syarat bounded context — bahasa domainnya sendiri (loading, armada, rute, stop, drop, driver), invariant sendiri (satu titik hanya boleh masuk satu armada per loading), dan boundary yang terbukti aman untuk dipisah tanpa memutus proses inti (FEFO/stock).

---

## Cakupan (scope)

```
Logistics
├── Armada              — master kendaraan distribusi per dapur
├── Delivery             — loading (gelombang) → armada → rute jam makan → stop → drop
└── Roles                — siapa boleh eksekusi status pengiriman (DRIVER, + manage roles)
```

**Bukan** cakupan Logistics (tetap domain lain):
- **Dispatch** (qty, tujuan, barang keluar gudang, FEFO) — tetap Food Production/Inventory (ADR-001).
- **Service Point** (Destination Master) — **bukan** milik Logistics. Sprint 5.3 Decision Record menyimpulkan ini *shared supporting domain*: Logistics mengonsumsinya untuk routing (jam kirim, drops, alamat), tapi tidak memilikinya. Field `kapasitasPorsi`/`porsiByKategori` di entitas yang sama justru kebutuhan Dispatch, bukan Logistics — bukti tambahan kenapa entitas ini netral.
- **Kitchen Assurance** (QC/HACCP/Cold Chain) — domain lain, tidak tersentuh pemisahan ini (lihat ADR-002).

---

## Model data

```
lib/logistics/
├── armada.ts   — ArmadaDoc, collection `armadas` (Sprint 2 Step 2)
├── delivery.ts — DeliveryLoading, DeliveryArmada, DeliveryArmadaStop, DeliveryStopDrop,
│                 buildDeliveryLoadings(), buildDeliveryArmadas(), resolveDeliveryLoadings()
│                 (Sprint 5.2)
└── roles.ts    — LOGISTICS_DELIVERY_STATUS_ROLES (Sprint 5.4)
```

**Storage saat ini (sengaja tidak diubah dalam ADR ini)**: `DeliveryLoading[]`/`DeliveryArmada[]` masih embedded di `DispatchDoc.loadings`/`.armadas`, dalam collection `distribution_orders` milik Food Production — bukan collection terpisah. `lib/logistics/delivery.ts` mengonsumsi `type DispatchLine` (snapshot, bukan pewarisan) dari `lib/food-production/distribution.ts` untuk membangun rute; `distribution.ts` sebaliknya mengimpor tipe `Delivery*` untuk merepresentasikan field yang sudah tertanam di dokumennya. Circular import ini disengaja (lihat detail di dokumen migrasi Sprint 5.2) — aman karena hanya deklarasi tipe/fungsi di top-level, bukan indikasi domain yang belum benar-benar terpisah.

Pemisahan storage sungguhan (collection `deliveries` terpisah + `dispatchId` sebagai FK asli + migration script + rewrite handler untuk atomic write) **belum dilakukan** — itu langkah migrasi lanjutan yang lebih besar, di luar cakupan ADR ini, dan baru relevan kalau kebutuhan operasional benar-benar menuntutnya (bukan demi "kerapian struktur").

`ArmadaDoc` (`kode`, `nama`, `platNomor`, `kapasitasPorsi`, `kitchenId?`) tidak berubah dari Sprint 2 Step 2.

---

## Roles

`LOGISTICS_DELIVERY_STATUS_ROLES = ['DRIVER', 'ADMIN', 'OWNER', 'SUPERVISOR', 'MASTER']` — mengatur siapa boleh mengeksekusi transisi status pengiriman (Dikirim/Selesai) pada `DispatchDoc`. Create/edit/cancel dokumen Dispatch, dan CRUD master Titik Layanan, tetap `FP_MANAGE_ROLES` (Food Production) — Logistics tidak memiliki wewenang di situ.

Sebelum Sprint 5.4, role-set ini bernama `FP_DIST_STATUS_ROLES` dan tinggal di `lib/food-production/roles.ts`. Dipindah bukan karena isinya berubah (tetap sama lima role), tapi karena kepemilikan konseptualnya: menentukan siapa boleh menjalankan aksi fisik pengiriman adalah keputusan Logistics.

---

## Nav & UI

Grup nav **Logistics** (`components/AppShell.tsx`, key `logistics`) berisi Armada — akses `SUPERVISOR`/`ADMIN`/`OWNER` (bukan `GUDANG`, konsisten dengan hak akses sebelum dipisah). Halaman Delivery (loading/armada/rute) belum punya route terpisah — masih menyatu dengan halaman Dispatch (`/food-production/distribution`, nav label "Jadwal Pengiriman") karena UI-nya sudah tergerbang per peran (`canManage` untuk susun rute, `canUpdateStatus`/`LOGISTICS_DELIVERY_STATUS_ROLES` untuk ubah status saja) — pemisahan route halaman bukan prasyarat pemisahan domain kode, dan belum dianggap perlu.

Role `DRIVER` (`components/AppShell.tsx` `ROLE_PERMISSIONS.DRIVER`) mengakses `/food-production/service-point` (baca) dan `/food-production/distribution` (baca + ubah status) — route ini tidak pindah karena Service Point tetap shared dan halaman Dispatch tetap satu untuk semua peran.

---

## Yang tidak dikembalikan / ditolak

- Collection `deliveries` terpisah dari `distribution_orders` — bukan sekarang (lihat "Model data" di atas).
- Memindahkan Service Point ke `lib/logistics/` — ditolak eksplisit di Sprint 5.3 Decision Record; entitas ini shared, bukan milik Logistics.
- Route planning/optimasi otomatis, tracking GPS real-time, driver mobile app terpisah — belum ada kebutuhan operasional terverifikasi; di luar cakupan ADR ini.

---

## Dokumen terkait

- [docs/migration/FOOD-PRODUCTION-DOMAIN-SPLIT.md](../migration/FOOD-PRODUCTION-DOMAIN-SPLIT.md) — checklist eksekusi Sprint 1–5 lengkap dengan audit dependensi yang mendasari ADR ini.
- [001-food-production-domain.md](./001-food-production-domain.md) — revisi pasca-migrasi, domain Dispatch & Service Point.
- [002-kitchen-assurance.md](./002-kitchen-assurance.md) — domain terpisah, tidak tersentuh pemisahan ini.
- [REGISTER.md](./REGISTER.md)

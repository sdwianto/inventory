// Bootstrap akun master + indeks (tanpa mock tenant/toko demo).

import { v4 as uuidv4 } from 'uuid';
import { hashPassword } from './auth-helpers';
import {
  ensureMasterDataIndexes,
  REKENING_DEFAULTS,
  DEMO_PRODUCTS,
} from './tenant-master';
import { migrateStokLokasiFromProducts } from './stok-lokasi';
import { ensureDefaultRenamedToSppg } from './migrate-tenant-sppg';
import { ensureAllTenantsWarehouses } from './warehouses';
import { backfillAllProductGudang } from './product-warehouse';

export { REKENING_DEFAULTS, DEMO_PRODUCTS };

/** Akun bootstrap lintas-tenant; tidak ditampilkan di UI login. */
export const DEMO_USERS = [
  {
    email: 'master@dawam.com',
    password: 'master123',
    name: 'Master Operator',
    role: 'MASTER',
    tenantId: 'master',
    tenantName: 'Pusat',
  },
];

export async function ensureDemoUsers(db) {
  const usersCol = db.collection('users');
  for (const demo of DEMO_USERS) {
    const passwordHash = await hashPassword(demo.password);
    const existing = await usersCol.findOne({ email: demo.email });
    if (existing) {
      await usersCol.updateOne(
        { email: demo.email },
        {
          $set: {
            password: passwordHash,
            name: demo.name,
            role: demo.role,
            tenantId: demo.tenantId,
            tenantName: demo.tenantName,
          },
        },
      );
    } else {
      await usersCol.insertOne({
        id: uuidv4(),
        email: demo.email,
        password: passwordHash,
        name: demo.name,
        role: demo.role,
        tenantId: demo.tenantId,
        tenantName: demo.tenantName,
        createdAt: new Date(),
      });
    }
  }
}

let bootstrapDone = false;
let bootstrapPromise = null;

async function runBootstrap(db) {
  await ensureMasterDataIndexes(db);
  await migrateStokLokasiFromProducts(db);
  await ensureDefaultRenamedToSppg(db);
  await ensureDemoUsers(db);
  await ensureAllTenantsWarehouses(db);
  await backfillAllProductGudang(db);
  try {
    await db.collection('inventory_releases').createIndex({ tenantId: 1, tanggal: -1 });
  } catch (e) {
    if (e?.code !== 85 && e?.code !== 86) console.warn('inventory_releases index:', e.message);
  }
  bootstrapDone = true;
}

export async function ensureSeeded(db) {
  if (bootstrapDone) return;
  // Single-flight: request bersamaan menunggu bootstrap yang sama, bukan menjalankan paralel.
  if (!bootstrapPromise) {
    bootstrapPromise = runBootstrap(db).catch((e) => {
      bootstrapPromise = null; // izinkan retry pada request berikutnya jika gagal
      throw e;
    });
  }
  await bootstrapPromise;
}

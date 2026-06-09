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

export { REKENING_DEFAULTS, DEMO_PRODUCTS };

/** Satu akun bootstrap; tidak ditampilkan di UI login. */
export const DEMO_USERS = [
  {
    email: 'master@dawam.com',
    password: 'master123',
    name: 'Master Operator',
    role: 'MASTER',
    tenantId: 'master',
    tenantName: 'Pusat',
  },
  {
    email: 'admin@inventory.local',
    password: 'admin123',
    name: 'Admin Gudang',
    role: 'ADMIN',
    tenantId: 'sppg',
    tenantName: 'SPPG Penarukan 2',
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

let demoUsersDone = false;
let tenantMigrated = false;
let bootstrapDone = false;

export async function ensureSeeded(db) {
  if (bootstrapDone) return;
  await ensureMasterDataIndexes(db);
  await migrateStokLokasiFromProducts(db);
  if (!tenantMigrated) {
    await ensureDefaultRenamedToSppg(db);
    tenantMigrated = true;
  }
  if (!demoUsersDone) {
    await ensureDemoUsers(db);
    demoUsersDone = true;
  }
  bootstrapDone = true;
}

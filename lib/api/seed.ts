// Bootstrap akun master + indeks (tanpa mock tenant/toko demo).

import type { Db } from 'mongodb';
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

export interface DemoUserSeed {
  email: string;
  password: string;
  name: string;
  role: string;
  tenantId: string;
  tenantName: string;
}

/** Akun bootstrap lintas-tenant; tidak ditampilkan di UI login. */
export const DEMO_USERS: DemoUserSeed[] = [
  {
    email: 'master@dawam.com',
    password: 'master123',
    name: 'Master Operator',
    role: 'MASTER',
    tenantId: 'master',
    tenantName: 'Pusat',
  },
];

export async function ensureDemoUsers(db: Db): Promise<void> {
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
let bootstrapPromise: Promise<void> | null = null;

function mongoErrorCode(e: unknown): number | undefined {
  return (e as { code?: number })?.code;
}

async function runBootstrap(db: Db): Promise<void> {
  await ensureMasterDataIndexes(db);
  await migrateStokLokasiFromProducts(db);
  await ensureDefaultRenamedToSppg(db);
  await ensureDemoUsers(db);
  await ensureAllTenantsWarehouses(db);
  await backfillAllProductGudang(db);
  try {
    await db.collection('inventory_releases').createIndex({ tenantId: 1, tanggal: -1 });
  } catch (e: unknown) {
    const code = mongoErrorCode(e);
    if (code !== 85 && code !== 86) {
      console.warn('inventory_releases index:', (e as Error).message);
    }
  }
  bootstrapDone = true;
}

export async function ensureSeeded(db: Db): Promise<void> {
  if (bootstrapDone) return;
  if (!bootstrapPromise) {
    bootstrapPromise = runBootstrap(db).catch((e) => {
      bootstrapPromise = null;
      throw e;
    });
  }
  await bootstrapPromise;
}

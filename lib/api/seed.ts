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
import { normalizeUserEmail, userEmailFields } from './user-email';
import { hasSystemFlag, setSystemFlag } from './system-meta';

export { REKENING_DEFAULTS, DEMO_PRODUCTS };

const BOOTSTRAP_FLAG = 'inventory_bootstrap_complete';
const PRODUCT_GUDANG_BACKFILL_FLAG = 'product_gudang_backfill_v1';

const DEFAULT_BOOTSTRAP_PASSWORD = 'master123';

export interface DemoUserSeed {
  email: string;
  password: string;
  name: string;
  role: string;
  tenantId: string;
  tenantName: string;
}

/**
 * Satu akun bootstrap; tidak ditampilkan di UI login.
 * Di production wajib override via MASTER_BOOTSTRAP_EMAIL / MASTER_BOOTSTRAP_PASSWORD.
 */
export function getBootstrapUsers(): DemoUserSeed[] {
  return [
    {
      email: process.env.MASTER_BOOTSTRAP_EMAIL || 'master@dawam.com',
      password: process.env.MASTER_BOOTSTRAP_PASSWORD || DEFAULT_BOOTSTRAP_PASSWORD,
      name: 'Master Operator',
      role: 'MASTER',
      tenantId: 'master',
      tenantName: 'Pusat',
    },
  ];
}

/** @deprecated gunakan getBootstrapUsers() — tetap diekspor untuk kompatibilitas. */
export const DEMO_USERS = getBootstrapUsers();

export async function ensureDemoUsers(db: Db): Promise<void> {
  const usersCol = db.collection('users');
  const bootstrapUsers = getBootstrapUsers();
  const isProd = process.env.NODE_ENV === 'production';

  for (const demo of bootstrapUsers) {
    if (isProd && demo.password === DEFAULT_BOOTSTRAP_PASSWORD) {
      throw new Error(
        'Bootstrap master pakai password default di production. Set MASTER_BOOTSTRAP_PASSWORD (& MASTER_BOOTSTRAP_EMAIL) yang kuat di environment.',
      );
    }

    const email = normalizeUserEmail(demo.email);
    const existing = await usersCol.findOne({ email, tenantId: demo.tenantId });
    if (existing) {
      // Jangan timpa password yang sudah diubah operator; hanya selaraskan identitas.
      await usersCol.updateOne(
        { id: existing.id },
        {
          $set: {
            name: demo.name,
            role: demo.role,
            tenantId: demo.tenantId,
            tenantName: demo.tenantName,
            emailNormalized: email,
          },
        },
      );
    } else {
      await usersCol.insertOne({
        id: uuidv4(),
        ...userEmailFields(demo.email),
        password: await hashPassword(demo.password),
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
  if (await hasSystemFlag(db, BOOTSTRAP_FLAG)) {
    bootstrapDone = true;
    return;
  }
  await ensureMasterDataIndexes(db);
  await migrateStokLokasiFromProducts(db);
  await ensureDefaultRenamedToSppg(db);
  await ensureDemoUsers(db);
  await ensureAllTenantsWarehouses(db);
  if (!(await hasSystemFlag(db, PRODUCT_GUDANG_BACKFILL_FLAG))) {
    await backfillAllProductGudang(db);
    await setSystemFlag(db, PRODUCT_GUDANG_BACKFILL_FLAG);
  }
  try {
    await db.collection('inventory_releases').createIndex({ tenantId: 1, tanggal: -1 });
  } catch (e: unknown) {
    const code = mongoErrorCode(e);
    if (code !== 85 && code !== 86) {
      console.warn('inventory_releases index:', (e as Error).message);
    }
  }
  await setSystemFlag(db, BOOTSTRAP_FLAG);
  bootstrapDone = true;
}

export async function ensureSeeded(db: Db): Promise<void> {
  if (bootstrapDone) return;
  if (await hasSystemFlag(db, BOOTSTRAP_FLAG)) {
    bootstrapDone = true;
    return;
  }
  if (!bootstrapPromise) {
    bootstrapPromise = runBootstrap(db).catch((e) => {
      bootstrapPromise = null;
      throw e;
    });
  }
  await bootstrapPromise;
}

/** Hanya untuk script migrate — paksa bootstrap ulang. */
export async function resetBootstrapForMigration(db: Db): Promise<void> {
  await db.collection('system_meta').deleteOne({ key: BOOTSTRAP_FLAG });
  await db.collection('system_meta').deleteOne({ key: PRODUCT_GUDANG_BACKFILL_FLAG });
  bootstrapDone = false;
  bootstrapPromise = null;
}

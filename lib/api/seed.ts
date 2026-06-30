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

    const existing = await usersCol.findOne({ email: demo.email });
    if (existing) {
      // Jangan timpa password yang sudah diubah operator; hanya selaraskan identitas.
      await usersCol.updateOne(
        { email: demo.email },
        {
          $set: {
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

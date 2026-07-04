/** Koneksi MongoDB khusus database Sales (kasir) — bisa cluster terpisah dari inventory. */

import { MongoClient, type Db } from 'mongodb';
import { getSalesDbName, getSalesMongoUri, usesDedicatedSalesMongo } from '@/lib/api/sandbox-config';

type SalesMongoHandle = {
  client: MongoClient;
  db: Db;
  ownsClient: boolean;
};

function mongoClientOptions() {
  return {
    maxPoolSize: Number(process.env.MONGO_MAX_POOL_SIZE) || 8,
    minPoolSize: 0,
    maxIdleTimeMS: 60_000,
    serverSelectionTimeoutMS: 8_000,
    connectTimeoutMS: 10_000,
  };
}

/** Buka DB sales — pakai SALES_MONGO_URL jika di-set, else client inventory yang sama. */
export async function connectSalesMongo(
  inventoryClient?: MongoClient,
): Promise<SalesMongoHandle> {
  const uri = getSalesMongoUri();
  if (!uri) {
    throw new Error('MONGO_URL / SALES_MONGO_URL belum di-set');
  }

  if (usesDedicatedSalesMongo()) {
    const client = new MongoClient(uri, mongoClientOptions());
    await client.connect();
    const db = client.db(getSalesDbName());
    return { client, db, ownsClient: true };
  }

  const client = inventoryClient ?? new MongoClient(uri, mongoClientOptions());
  if (!inventoryClient) await client.connect();
  return { client, db: client.db(getSalesDbName()), ownsClient: !inventoryClient };
}

export async function closeSalesMongo(handle: SalesMongoHandle): Promise<void> {
  if (handle.ownsClient) {
    await handle.client.close().catch(() => {});
  }
}

// Shared MongoDB & response helpers for the API route.

import { MongoClient, type Db } from 'mongodb';
import { NextResponse } from 'next/server';

let clientPromise: Promise<{ client: MongoClient; db: Db }> | null = null;

function getMongoConfig() {
  const uri =
    process.env.MONGO_URL ||
    process.env.MONGODB_URI ||
    (process.env.NODE_ENV === 'development' ? 'mongodb://127.0.0.1:27017' : '');

  if (!uri || typeof uri !== 'string') {
    throw new Error(
      'MONGO_URL belum di-set. Buat .env.local dengan: MONGO_URL=mongodb://127.0.0.1:27017',
    );
  }

  return {
    uri,
    dbName: process.env.DB_NAME || 'inventory_customer',
  };
}

async function connectMongoClient(): Promise<{ client: MongoClient; db: Db }> {
  if (!clientPromise) {
    const { uri, dbName } = getMongoConfig();
    clientPromise = (async () => {
      const client = new MongoClient(uri, {
        maxPoolSize: 20,
        minPoolSize: 2,
        maxIdleTimeMS: 60_000,
        serverSelectionTimeoutMS: 8_000,
        connectTimeoutMS: 10_000,
      });
      await client.connect();
      return { client, db: client.db(dbName) };
    })().catch((e) => {
      clientPromise = null;
      throw e;
    });
  }
  return clientPromise;
}

export async function connectToMongo(): Promise<Db> {
  const { db } = await connectMongoClient();
  return db;
}

export async function getMongoClient(): Promise<MongoClient> {
  const { client } = await connectMongoClient();
  return client;
}

function resolveCorsOrigin(): string {
  const configured = process.env.CORS_ORIGINS?.trim();
  if (configured) return configured;
  if (process.env.NODE_ENV === 'development') return '*';
  return '';
}

export function cors(res: NextResponse): NextResponse {
  const origin = resolveCorsOrigin();
  if (origin) {
    res.headers.set('Access-Control-Allow-Origin', origin);
  }
  res.headers.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.headers.set(
    'Access-Control-Allow-Headers',
    'Content-Type, Authorization, X-Webhook-Secret, X-Event',
  );
  return res;
}

export function ok<T>(data: T, status = 200): NextResponse {
  return cors(NextResponse.json(data, { status }));
}

export function err(msg: string, status = 400): NextResponse {
  return cors(NextResponse.json({ error: msg }, { status }));
}

/** Strip MongoDB internal _id before sending to client. */
export function clean<T extends Record<string, unknown>>(
  doc: T | null | undefined,
): Omit<T, '_id'> | T | null | undefined {
  if (!doc) return doc;
  const { _id: _unused, ...rest } = doc;
  void _unused;
  return rest as Omit<T, '_id'>;
}

// Shared MongoDB & response helpers for the API route.
// Centralized here so multiple handlers can reuse without duplication.

import { MongoClient } from 'mongodb';
import { NextResponse } from 'next/server';

let clientPromise = null;

function getMongoConfig() {
  const uri =
    process.env.MONGO_URL ||
    process.env.MONGODB_URI ||
    (process.env.NODE_ENV === 'development' ? 'mongodb://127.0.0.1:27017' : '');

  if (!uri || typeof uri !== 'string') {
    throw new Error(
      'MONGO_URL belum di-set. Buat .env.local dengan: MONGO_URL=mongodb://127.0.0.1:27017'
    );
  }

  return {
    uri,
    dbName: process.env.DB_NAME || 'inventory_customer',
  };
}

export async function connectToMongo() {
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
      return client.db(dbName);
    })().catch((e) => {
      clientPromise = null;
      throw e;
    });
  }
  return clientPromise;
}

export function cors(res) {
  res.headers.set('Access-Control-Allow-Origin', '*');
  res.headers.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Webhook-Secret, X-Event');
  return res;
}

export function ok(data, status = 200) {
  return cors(NextResponse.json(data, { status }));
}

export function err(msg, status = 400) {
  return cors(NextResponse.json({ error: msg }, { status }));
}

// Strip MongoDB internal _id (not JSON-friendly) before sending to client.
export function clean(doc) {
  if (!doc) return doc;
  const { _id, ...rest } = doc;
  return rest;
}

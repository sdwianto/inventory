import fs from 'fs';
import { MongoClient } from 'mongodb';
const env = Object.fromEntries(
  fs.readFileSync('.env.local','utf8').split('\n')
    .filter(l=>l.includes('=') && !l.trim().startsWith('#'))
    .map(l=>{const i=l.indexOf('=');return[l.slice(0,i),l.slice(i+1)]})
);
const emails = ['admin@inventory.local','staff@inventory.local','supervisor@inventory.local'];
const client = await MongoClient.connect(env.MONGO_URL);
const db = client.db(env.DB_NAME);
const inQ = { email: { ['\u0024in']: emails } };
const before = await db.collection('users').find(inQ).project({ email:1, role:1, name:1 }).toArray();
console.log('BEFORE:', JSON.stringify(before, null, 2));
const r = await db.collection('users').deleteMany(inQ);
console.log('DELETED:', r.deletedCount);
const after = await db.collection('users').find({}).project({ email:1, role:1, name:1 }).toArray();
console.log('REMAINING USERS:', JSON.stringify(after, null, 2));
await client.close();

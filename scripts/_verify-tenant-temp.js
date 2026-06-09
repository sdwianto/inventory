const {MongoClient}=require("mongodb");const fs=require("fs");
const env=Object.fromEntries(fs.readFileSync(".env.local","utf8").split("\n").filter(l=>l.includes("=")).map(l=>{const i=l.indexOf("=");return[l.slice(0,i),l.slice(i+1)]}));
(async()=>{const c=new MongoClient(env.MONGO_URL);await c.connect();const db=c.db(env.DB_NAME);
console.log("default_settings",await db.collection("tenant_settings").countDocuments({tenantId:"default"}));
console.log("sppg_settings",JSON.stringify(await db.collection("tenant_settings").findOne({tenantId:"sppg"},{projection:{tenantId:1,companyName:1,logoBase64:{$exists:true}}})));
await c.close();})();

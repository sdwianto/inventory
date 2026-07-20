# Deploy VPS — Inventory lite (standalone compose)

Untuk stack **Sales + Inventory + Execution Platform**, pakai runbook Sales:  
`../../sales/sales/docs/DEPLOY-VPS.md`

Dokumen ini untuk deploy **Inventory saja** via `inventory-app/docker-compose.yml`.

## Gap yang sering muncul (dev OK, VPS gagal)

| Gejala | Penyebab | Fix |
|--------|----------|-----|
| `EACCES mkdir '/app/storage'` | User `nextjs` tidak bisa tulis media | Volume `media_data` + entrypoint chown (sudah di image) |
| `sales_pkgs:latest 403` / build gagal | Compose tanpa `additional_contexts` | Compose wajib `sales_pkgs: ../../sales/sales/packages` |
| Transaksi Mongo gagal di production | Mongo tanpa replica set | Compose pakai `--replSet rs0` |
| Cache/rate-limit degraded | Tanpa Redis | Service `redis` + `REDIS_URL` |
| Foto resep gagal setelah rebuild | Volume lama root-owned | Entrypoint probe write; atau `chown -R 1001:1001` volume |

## Quick start

```bash
# Di host: layout sibling wajib
#   Assignment/inventory/inventory-app
#   Assignment/sales/sales/packages

cd ~/inventory/inventory-app   # atau path VPS Anda
cp .env.docker.example .env.docker
# Edit secrets: SESSION_SECRET, WORKER_SECRET, MASTER_BOOTSTRAP_PASSWORD, INTEGRATION_SETUP_TOKEN

docker compose --env-file .env.docker build inventory-app
docker compose --env-file .env.docker up -d

# Smoke
curl -sS http://127.0.0.1:3001/api/health | head
# Buat resep + gambar → tidak boleh EACCES
```

## Catatan

- Jangan set `DEPLOYMENT_MODE=vps` + `JOB_BUS_ENABLED=1` di lite stack tanpa execution worker (job bus akan mematikan HTTP poll).
- Enterprise: deploy dari `sales/sales` compose (service name `inventory`, bukan `inventory-app`).

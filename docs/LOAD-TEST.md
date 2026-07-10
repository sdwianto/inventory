# Load Test — Inventory Hot Path (M3.1)

Skrip Node untuk smoke/load test endpoint berat Inventory.

## Prasyarat

- Node 22+
- Session cookie tenant operasional (login browser → DevTools → Application → Cookies)

## Variabel

| Env | Default | Keterangan |
|-----|---------|------------|
| `BASE_URL` | `http://localhost:3001` | URL Inventory app |
| `ITERATIONS` | `20` | Ulangi tiap endpoint |
| `SESSION_COOKIE` | — | Cookie session (`next-auth.session-token=...`) |
| `TENANT_ID` | — | Header `X-Tenant-Id` (MASTER acting-as) |

## Menjalankan

```bash
# Smoke lokal (health only tanpa auth)
npm run test:load

# Staging / production
BASE_URL=https://penarukan2.vercel.app \
SESSION_COOKIE="next-auth.session-token=..." \
TENANT_ID=sppg \
ITERATIONS=50 \
npm run test:load
```

## Threshold (default script)

| Endpoint | p95 target |
|----------|------------|
| `/api/health` | &lt; 500 ms |
| `/api/dashboard` | &lt; 2000 ms |
| `/api/inventory/stok-saldo` | &lt; 2000 ms |
| `/api/pages/produk` | &lt; 2000 ms |
| `/api/maintenance-reports` | &lt; 2000 ms |

Gate M2 audit: 50× page load p95 &lt; 2s — set `ITERATIONS=50`.

## CI

Load test **tidak** dijalankan di CI (butuh auth + tenant). Jalankan manual sebelum release besar atau setelah perubahan hot path.

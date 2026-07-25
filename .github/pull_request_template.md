## Summary
<!-- 1–3 bullet -->

## Type
- [ ] Feature
- [ ] Bugfix
- [ ] Performance
- [ ] Integration (Sales ↔ Inventory)
- [ ] Docs / chore

## Guardrails (W1-7 — wajib jika menyentuh cross-app / integration)
- [ ] Tidak ada `fetch`/`axios` langsung ke peer app di path Category A/B
- [ ] Memakai `IntegrationClient` + Transport
- [ ] `X-Correlation-Id` (+ `Idempotency-Key` untuk Category A)
- [ ] Contract Spec / contract test di-update bila endpoint Cat A berubah
- [ ] Error peer memakai `IntegrationError` + `errorClass` (bukan raw `Error`)
- [ ] Tidak mutate aggregate milik peer (lihat Sales Ownership / Aggregate Boundary)
- [ ] Tidak enqueue sebelum commit lokal (outbox after commit)

Canonical conventions: Sales `docs/architecture/W1-7-ENGINEERING-CONVENTIONS.md`.

## Performance (jika menyentuh API/worker/list)
- [ ] Tidak ada poll Sales job di worker path
- [ ] Outbound ke Sales ≤ 15s soft / 20s hard; retry via job
- [ ] UI poll hanya status transitional
- [ ] Invalidate sempit

## Test plan
- [ ] Unit / kontrak terkait
- [ ] `npm run check:no-peer-fetch` bila menyentuh `lib/api`
- [ ] Manual / E2E bila flow procurement berubah

## Risk / rollback
<!-- Satu kalimat -->

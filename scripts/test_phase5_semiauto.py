#!/usr/bin/env python3
"""
Semi-automated verification for Phase 5 hardening.

Coverage focus:
- seed access control (MASTER-only)
- tenant-scoped closing/depreciation
- period lock enforcement (HTTP 423)
- stok_lokasi / transfer consistency
- scoped access sanity checks
- proxy guard (unauthenticated page redirect)
"""

from __future__ import annotations

import os
import sys
import time
from datetime import datetime, timedelta
from typing import Any

import requests


BASE_APP_URL = os.getenv("APP_URL", "http://localhost:3000")
BASE_API_URL = os.getenv("API_URL", f"{BASE_APP_URL}/api")

ADMIN_EMAIL = os.getenv("ADMIN_EMAIL", "admin@dawam.com")
ADMIN_PASSWORD = os.getenv("ADMIN_PASSWORD", "admin123")
MASTER_EMAIL = os.getenv("MASTER_EMAIL", "master@dawam.com")
MASTER_PASSWORD = os.getenv("MASTER_PASSWORD", "master123")


def unwrap(payload: Any) -> Any:
    if isinstance(payload, dict) and "data" in payload:
        return payload["data"]
    return payload


class TestRunner:
    def __init__(self) -> None:
        self.results: list[tuple[str, bool, str]] = []
        self.admin = requests.Session()
        self.master = requests.Session()
        self.admin_user: dict[str, Any] = {}
        self.master_user: dict[str, Any] = {}
        self.created: dict[str, Any] = {}

    def log(self, name: str, ok: bool, detail: str = "") -> None:
        self.results.append((name, ok, detail))
        icon = "PASS" if ok else "FAIL"
        suffix = f" - {detail}" if detail else ""
        print(f"[{icon}] {name}{suffix}")

    def req(self, sess: requests.Session, method: str, path: str, **kwargs: Any) -> requests.Response:
        return sess.request(method, f"{BASE_API_URL}{path}", timeout=20, **kwargs)

    def login(self, sess: requests.Session, email: str, password: str) -> tuple[bool, dict[str, Any]]:
        r = self.req(sess, "POST", "/auth/login", json={"email": email, "password": password})
        if r.status_code != 200:
            return False, {}
        payload = unwrap(r.json())
        user = payload.get("user", {}) if isinstance(payload, dict) else {}
        return bool(user.get("id") and user.get("role")), user

    def run(self) -> int:
        self.test_auth_and_proxy()
        if not self.admin_user or not self.master_user:
            return self.summarize()
        self.test_seed_access_control()
        self.test_master_tenant_pick_required()
        self.test_stock_transfer_and_total_consistency()
        self.test_period_lock_and_posting_block()
        self.test_scoped_lookup_sanity()
        return self.summarize()

    def summarize(self) -> int:
        passed = sum(1 for _, ok, _ in self.results if ok)
        total = len(self.results)
        failed = total - passed
        print("\n=== SUMMARY ===")
        print(f"Passed: {passed}/{total}")
        print(f"Failed: {failed}/{total}")
        print("\nManual-only checklist items still needed:")
        print("- Deep UI flow (visual/AppShell behavior in browser)")
        print("- Cross-tenant IDOR with two real non-default tenants")
        print("- Full regression across all pages")
        return 0 if failed == 0 else 1

    def test_auth_and_proxy(self) -> None:
        ok_admin, self.admin_user = self.login(self.admin, ADMIN_EMAIL, ADMIN_PASSWORD)
        ok_master, self.master_user = self.login(self.master, MASTER_EMAIL, MASTER_PASSWORD)
        self.log("Login ADMIN", ok_admin, self.admin_user.get("role", ""))
        self.log("Login MASTER", ok_master, self.master_user.get("role", ""))

        anon = requests.Session()
        r = anon.get(f"{BASE_APP_URL}/dashboard", allow_redirects=False, timeout=20)
        redirected = r.status_code in (301, 302, 307, 308) and r.headers.get("Location", "").startswith("/")
        self.log("Proxy guard unauthenticated /dashboard redirect", redirected, f"status={r.status_code}")

    def test_seed_access_control(self) -> None:
        r_admin = self.req(self.admin, "POST", "/auth/seed")
        self.log("Seed blocked for ADMIN", r_admin.status_code == 403, f"status={r_admin.status_code}")

        r_master = self.req(self.master, "POST", "/auth/seed")
        self.log("Seed allowed for MASTER", r_master.status_code == 200, f"status={r_master.status_code}")

    def test_master_tenant_pick_required(self) -> None:
        period = datetime.now().strftime("%Y-%m")
        r = self.req(self.master, "POST", "/tutup-buku", json={"period": period, "userName": "phase5-test"})
        self.log("MASTER close-book requires tenantId", r.status_code == 400, f"status={r.status_code}")

        r2 = self.req(self.master, "POST", "/penyusutan/run", json={"period": period, "userName": "phase5-test"})
        self.log("MASTER depreciation requires tenantId", r2.status_code == 400, f"status={r2.status_code}")

    def test_stock_transfer_and_total_consistency(self) -> None:
        rp = self.req(self.admin, "GET", "/products?limit=1")
        if rp.status_code != 200:
            self.log("Load product for transfer", False, f"status={rp.status_code}")
            return
        products = unwrap(rp.json())
        if not products:
            self.log("Load product for transfer", False, "no products")
            return
        p = products[0]
        stok_id = p["id"]
        before_total = float(p.get("stok", 0))

        rl = self.req(self.admin, "GET", "/lokasi")
        if rl.status_code != 200:
            self.log("Load lokasi for transfer", False, f"status={rl.status_code}")
            return
        lokasi = unwrap(rl.json())
        if len(lokasi) < 2:
            self.log("Need >=2 lokasi for transfer", False, "insufficient lokasi")
            return
        asal, tujuan = lokasi[0], lokasi[1]
        qty = 1

        rt = self.req(
            self.admin,
            "POST",
            "/stok/transfer",
            json={
                "lokasiAsal": asal["kode"],
                "lokasiAsalNama": asal.get("nama", asal["kode"]),
                "lokasiTujuan": tujuan["kode"],
                "lokasiTujuanNama": tujuan.get("nama", tujuan["kode"]),
                "items": [{"stokId": stok_id, "kode": p.get("kode"), "qty": qty, "hargaBeli": p.get("hargaBeli", 0)}],
                "userName": "phase5-test",
            },
        )
        self.log("Stock transfer succeeds", rt.status_code == 200, f"status={rt.status_code}")
        if rt.status_code != 200:
            return

        rp2 = self.req(self.admin, "GET", f"/products?q={p.get('kode','')}&limit=5")
        if rp2.status_code != 200:
            self.log("Reload product after transfer", False, f"status={rp2.status_code}")
            return
        products_after = unwrap(rp2.json())
        updated = next((x for x in products_after if x["id"] == stok_id), None)
        if not updated:
            self.log("Find transferred product", False, "not found")
            return
        after_total = float(updated.get("stok", 0))
        self.log("Product total stock unchanged by transfer", abs(after_total - before_total) < 1e-6, f"{before_total} -> {after_total}")

    def test_period_lock_and_posting_block(self) -> None:
        # close previous month so new month operations can still run
        prev = (datetime.now().replace(day=1) - timedelta(days=1)).strftime("%Y-%m")
        close_res = self.req(self.admin, "POST", "/tutup-buku", json={"period": prev, "userName": "phase5-test"})
        closed = close_res.status_code == 200
        self.log("Close previous period as ADMIN", closed, f"status={close_res.status_code}")
        if not closed:
            return

        lock_date = f"{prev}-15"
        j = self.req(
            self.admin,
            "POST",
            "/jurnal",
            json={
                "tanggal": lock_date,
                "keterangan": "lock-test",
                "details": [
                    {"rekeningKode": "10010", "rekeningNama": "Kas", "debet": 1000, "kredit": 0},
                    {"rekeningKode": "30030", "rekeningNama": "Pendapatan", "debet": 0, "kredit": 1000},
                ],
            },
        )
        self.log("Period lock blocks manual journal", j.status_code == 423, f"status={j.status_code}")

        km = self.req(
            self.admin,
            "POST",
            "/kas-masuk",
            json={
                "tanggal": lock_date,
                "keterangan": "lock-test-km",
                "details": [{"rekeningKode": "30030", "rekeningNama": "Pendapatan Lain", "jumlah": 1000}],
            },
        )
        self.log("Period lock blocks kas masuk", km.status_code == 423, f"status={km.status_code}")

    def test_scoped_lookup_sanity(self) -> None:
        # Basic sanity: list endpoints still work after scoped refactor
        checks = [
            ("GET /laporan/piutang", self.req(self.admin, "GET", "/laporan/piutang").status_code == 200),
            ("GET /laporan/hutang", self.req(self.admin, "GET", "/laporan/hutang").status_code == 200),
            ("GET /members", self.req(self.admin, "GET", "/members").status_code == 200),
            ("GET /supplier", self.req(self.admin, "GET", "/supplier").status_code == 200),
        ]
        for name, ok in checks:
            self.log(name, ok)


def main() -> int:
    print(f"Base App URL: {BASE_APP_URL}")
    print(f"Base API URL: {BASE_API_URL}")
    runner = TestRunner()
    return runner.run()


if __name__ == "__main__":
    sys.exit(main())


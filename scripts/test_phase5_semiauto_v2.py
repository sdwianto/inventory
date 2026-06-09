#!/usr/bin/env python3
"""
Phase 5 semi-automated test suite v2.

Adds over v1:
- Cross-tenant isolation (create 2 tenants + admin users + products)
- Expanded period-lock endpoint checks
- Stok lokasi transfer + oversell rejection
- MongoDB integrity via scripts/phase5_mongo_integrity.mjs
- Checklist matrix: COVERED | PARTIAL | MANUAL | FAIL | SKIP

Prerequisites:
  - App running: npm run dev
  - pip install requests (usually preinstalled)
  - node + project deps for mongo check

Usage:
  python3 scripts/test_phase5_semiauto_v2.py
  APP_URL=http://localhost:3000 python3 scripts/test_phase5_semiauto_v2.py
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import time
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from enum import Enum
from typing import Any

import requests
from requests.exceptions import ConnectionError as RequestsConnectionError

# Set by resolve_runtime_urls() before runner starts
BASE_APP_URL = "http://localhost:3000"
BASE_API_URL = "http://localhost:3000/api"
ADMIN_EMAIL = os.getenv("ADMIN_EMAIL", "admin@dawam.com")
ADMIN_PASSWORD = os.getenv("ADMIN_PASSWORD", "admin123")
MASTER_EMAIL = os.getenv("MASTER_EMAIL", "master@dawam.com")
MASTER_PASSWORD = os.getenv("MASTER_PASSWORD", "master123")
RUN_MONGO = os.getenv("RUN_MONGO", "1") != "0"
CLEANUP_TENANTS = os.getenv("CLEANUP_TENANTS", "1") != "0"


class Coverage(str, Enum):
    COVERED = "COVERED"
    PARTIAL = "PARTIAL"
    MANUAL = "MANUAL"
    FAIL = "FAIL"
    SKIP = "SKIP"


@dataclass
class ChecklistItem:
    section: str
    item: str
    coverage: Coverage = Coverage.MANUAL
    note: str = ""


def as_list(payload: Any) -> list:
    if isinstance(payload, list):
        return payload
    if isinstance(payload, dict):
        if isinstance(payload.get("data"), list):
            return payload["data"]
        if isinstance(payload.get("rows"), list):
            return payload["rows"]
    return []


def load_dotenv_local() -> dict[str, str]:
    """Parse project .env.local (no extra deps)."""
    env: dict[str, str] = {}
    root = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
    path = os.path.join(root, ".env.local")
    if not os.path.isfile(path):
        return env
    with open(path, encoding="utf-8") as f:
        for line in f:
            t = line.strip()
            if not t or t.startswith("#") or "=" not in t:
                continue
            k, v = t.split("=", 1)
            env[k.strip()] = v.strip()
    return env


def wsl_windows_host_url(port: int = 3000) -> str | None:
    """If dev server runs on Windows while tests run in WSL, use nameserver IP."""
    try:
        with open("/etc/resolv.conf", encoding="utf-8") as f:
            for line in f:
                parts = line.split()
                if len(parts) >= 2 and parts[0] == "nameserver" and parts[1] != "127.0.0.1":
                    return f"http://{parts[1]}:{port}"
    except OSError:
        pass
    return None


def probe_api(api_url: str, timeout: float = 3) -> bool:
    try:
        r = requests.get(f"{api_url.rstrip('/')}/", timeout=timeout)
        return r.status_code == 200
    except RequestsConnectionError:
        return False
    except requests.RequestException:
        return False


def resolve_runtime_urls() -> tuple[str, str]:
    """Pick first reachable APP/API base URL."""
    env_file = load_dotenv_local()
    port = int(os.getenv("APP_PORT", "3000"))
    candidates: list[str] = []

    if os.getenv("APP_URL"):
        candidates.append(os.getenv("APP_URL", "").rstrip("/"))
    if os.getenv("API_URL"):
        api = os.getenv("API_URL", "").rstrip("/")
        return api.replace("/api", ""), api

    if env_file.get("NEXT_PUBLIC_BASE_URL"):
        candidates.append(env_file["NEXT_PUBLIC_BASE_URL"].rstrip("/"))

    candidates.extend([
        f"http://localhost:{port}",
        f"http://127.0.0.1:{port}",
    ])
    win = wsl_windows_host_url(port)
    if win:
        candidates.append(win.rstrip("/"))

    seen: set[str] = set()
    for app in candidates:
        if not app or app in seen:
            continue
        seen.add(app)
        api = f"{app}/api"
        if probe_api(api):
            return app, api

    return candidates[0] if candidates else f"http://localhost:{port}", f"http://localhost:{port}/api"


def wait_for_server(api_url: str, max_sec: int = 90) -> bool:
    print(f"Menunggu server di {api_url} (max {max_sec}s)...")
    deadline = time.time() + max_sec
    while time.time() < deadline:
        if probe_api(api_url, timeout=2):
            print("Server siap.\n")
            return True
        time.sleep(2)
    return False


def ensure_server_or_exit(app_url: str, api_url: str) -> None:
    if probe_api(api_url):
        return
    if os.getenv("WAIT_FOR_SERVER", "0") == "1":
        if wait_for_server(api_url, int(os.getenv("SERVER_WAIT_SEC", "90"))):
            return
    print(
        "\nERROR: Tidak bisa terhubung ke API.\n"
        f"  URL dicoba: {api_url}/\n\n"
        "Penyebab umum:\n"
        "  1. Dev server belum jalan — di terminal lain:\n"
        "       npm run dev\n"
        "  2. Dev server di Windows, test di WSL — coba:\n"
        "       APP_URL=http://$(grep nameserver /etc/resolv.conf | awk '{print $2}'):3000 \\\n"
        "       python3 scripts/test_phase5_semiauto_v2.py\n"
        "  3. Port lain — set APP_URL=http://localhost:<port>\n\n"
        "Opsional tunggu otomatis:\n"
        "  WAIT_FOR_SERVER=1 python3 scripts/test_phase5_semiauto_v2.py\n",
        file=sys.stderr,
    )
    sys.exit(2)


def as_dict(payload: Any) -> dict:
    if isinstance(payload, dict):
        if isinstance(payload.get("data"), dict):
            return payload["data"]
        return payload
    return {}


class Phase5V2Runner:
    def __init__(self) -> None:
        self.ts = int(time.time())
        self.tenant_a = f"phase5a-{self.ts}"
        self.tenant_b = f"phase5b-{self.ts}"
        self.checklist: list[ChecklistItem] = []
        self.assertions: list[tuple[str, bool, str]] = []

        self.admin = requests.Session()
        self.master = requests.Session()
        self.tenant_a_sess = requests.Session()
        self.tenant_b_sess = requests.Session()

        self.admin_user: dict = {}
        self.master_user: dict = {}
        self.prod_a: dict = {}
        self.prod_b: dict = {}
        self.sup_a: dict = {}
        self.sup_b: dict = {}
        self.pel_a: dict = {}
        self.pel_b: dict = {}
        self.user_a_email = f"admin.{self.tenant_a}@phase5.test"
        self.user_b_email = f"admin.{self.tenant_b}@phase5.test"
        self.user_password = "phase5test123"

    def mark(self, section: str, item: str, coverage: Coverage, note: str = "") -> None:
        self.checklist.append(ChecklistItem(section, item, coverage, note))

    def assert_test(self, name: str, ok: bool, detail: str = "") -> None:
        self.assertions.append((name, ok, detail))
        tag = "PASS" if ok else "FAIL"
        suffix = f" - {detail}" if detail else ""
        print(f"  [{tag}] {name}{suffix}")

    def req(self, sess: requests.Session, method: str, path: str, **kwargs) -> requests.Response:
        try:
            return sess.request(method, f"{BASE_API_URL}{path}", timeout=30, **kwargs)
        except RequestsConnectionError as e:
            raise SystemExit(
                f"\nKoneksi putus ke {BASE_API_URL}{path}. Pastikan `npm run dev` masih berjalan.\n"
            ) from e

    def login(self, sess: requests.Session, email: str, password: str) -> tuple[bool, dict]:
        r = self.req(sess, "POST", "/auth/login", json={"email": email, "password": password})
        if r.status_code != 200:
            return False, {}
        body = r.json()
        user = body.get("user") if isinstance(body, dict) else {}
        if not user and isinstance(body, dict) and "data" in body:
            user = body["data"].get("user", {})
        return bool(user.get("role")), user

    def run(self) -> int:
        print(f"APP_URL={BASE_APP_URL}")
        print(f"API_URL={BASE_API_URL}")
        print(f"Test tenants: {self.tenant_a}, {self.tenant_b}\n")

        self.section_1_smoke()
        if not self.admin_user.get("role") or not self.master_user.get("role"):
            self.print_matrix()
            return 1

        self.section_2_proxy()
        self.section_3_seed()
        self.section_4_5_tutup_penyusutan()
        self.section_6_period_lock()
        self.section_7_stok_lokasi()
        self.section_8_idor_cross_tenant()
        self.section_9_regression()
        self.section_10_mongo()

        return self.finish()

    # --- sections ---

    def section_1_smoke(self) -> None:
        print("=== 1) Smoke ===")
        ok_a, self.admin_user = self.login(self.admin, ADMIN_EMAIL, ADMIN_PASSWORD)
        ok_m, self.master_user = self.login(self.master, MASTER_EMAIL, MASTER_PASSWORD)
        self.assert_test("Login ADMIN", ok_a, self.admin_user.get("role", ""))
        self.assert_test("Login MASTER", ok_m, self.master_user.get("role", ""))

        self.mark("1 Smoke", "npm run dev tanpa error compile", Coverage.MANUAL, "Cek terminal dev server")
        self.mark(
            "1 Smoke",
            "Login berhasil",
            Coverage.COVERED if ok_a and ok_m else Coverage.FAIL,
        )
        self.mark("1 Smoke", "Halaman setelah login tidak redirect loop", Coverage.MANUAL, "Buka /dashboard di browser")
        r = self.req(self.admin, "POST", "/auth/logout")
        self.mark(
            "1 Smoke",
            "Logout API",
            Coverage.COVERED if r.status_code == 200 else Coverage.PARTIAL,
        )
        self.login(self.admin, ADMIN_EMAIL, ADMIN_PASSWORD)

    def section_2_proxy(self) -> None:
        print("\n=== 2) Proxy guard ===")
        anon = requests.Session()
        for path in ("/dashboard", "/kasir"):
            r = anon.get(f"{BASE_APP_URL}{path}", allow_redirects=False, timeout=20)
            ok = r.status_code in (301, 302, 307, 308) and r.headers.get("Location", "").startswith("/")
            self.assert_test(f"Unauthenticated {path} redirect", ok, f"status={r.status_code}")
            self.mark(
                "2 Proxy",
                f"Belum login buka {path} -> redirect /",
                Coverage.COVERED if ok else Coverage.FAIL,
            )

        r_api = anon.get(f"{BASE_API_URL}/auth/me", timeout=20)
        api_ok = r_api.status_code == 401
        self.assert_test("API /auth/me tetap 401 tanpa session", api_ok, f"status={r_api.status_code}")
        self.mark(
            "2 Proxy",
            "API tidak rusak oleh proxy",
            Coverage.COVERED if api_ok else Coverage.FAIL,
        )

    def section_3_seed(self) -> None:
        print("\n=== 3) /auth/seed ===")
        r_a = self.req(self.admin, "POST", "/auth/seed")
        r_m = self.req(self.master, "POST", "/auth/seed")
        self.assert_test("ADMIN seed -> 403", r_a.status_code == 403, f"status={r_a.status_code}")
        self.assert_test("MASTER seed -> 200", r_m.status_code == 200, f"status={r_m.status_code}")
        self.mark("3 Seed", "ADMIN POST /auth/seed -> 403", Coverage.COVERED if r_a.status_code == 403 else Coverage.FAIL)
        self.mark("3 Seed", "MASTER POST /auth/seed -> 200", Coverage.COVERED if r_m.status_code == 200 else Coverage.FAIL)

    def setup_cross_tenant(self) -> bool:
        print("\n=== Setup cross-tenant ===")
        for tid, name in ((self.tenant_a, "Phase5 Tenant A"), (self.tenant_b, "Phase5 Tenant B")):
            r = self.req(
                self.master,
                "POST",
                "/tenants",
                json={"tenantId": tid, "tenantName": name, "seedDemoProducts": False},
            )
            if r.status_code not in (200, 409):
                self.assert_test(f"Create tenant {tid}", False, f"status={r.status_code} {r.text[:120]}")
                return False
            self.assert_test(f"Create tenant {tid}", True, f"status={r.status_code}")

        # Products with markers
        ra = self.req(
            self.master,
            "POST",
            "/products",
            json={
                "tenantId": self.tenant_a,
                "kode": f"P5A-{self.ts}",
                "nama": "Produk Tenant A",
                "hargaEcer": 10000,
                "stok": 20,
            },
        )
        rb = self.req(
            self.master,
            "POST",
            "/products",
            json={
                "tenantId": self.tenant_b,
                "kode": f"P5B-{self.ts}",
                "nama": "Produk Tenant B",
                "hargaEcer": 12000,
                "stok": 15,
            },
        )
        if ra.status_code != 200 or rb.status_code != 200:
            self.assert_test("Create marker products", False, f"A={ra.status_code} B={rb.status_code}")
            return False
        self.prod_a = ra.json() if isinstance(ra.json(), dict) else {}
        self.prod_b = rb.json() if isinstance(rb.json(), dict) else {}
        self.assert_test("Create marker products", True, f"A={self.prod_a.get('kode')} B={self.prod_b.get('kode')}")

        # Supplier markers
        sa = self.req(
            self.master,
            "POST",
            "/supplier",
            json={"tenantId": self.tenant_a, "kode": f"SA-{self.ts}", "nama": "Supplier A"},
        )
        sb = self.req(
            self.master,
            "POST",
            "/supplier",
            json={"tenantId": self.tenant_b, "kode": f"SB-{self.ts}", "nama": "Supplier B"},
        )
        if sa.status_code == 200:
            self.sup_a = sa.json()
        if sb.status_code == 200:
            self.sup_b = sb.json()
        self.assert_test("Create marker suppliers", sa.status_code == 200 and sb.status_code == 200, f"A={sa.status_code} B={sb.status_code}")

        # Pelanggan markers
        pa = self.req(
            self.master,
            "POST",
            "/pelanggan",
            json={"tenantId": self.tenant_a, "kode": f"PA-{self.ts}", "nama": "Pelanggan A"},
        )
        pb = self.req(
            self.master,
            "POST",
            "/pelanggan",
            json={"tenantId": self.tenant_b, "kode": f"PB-{self.ts}", "nama": "Pelanggan B"},
        )
        if pa.status_code == 200:
            self.pel_a = pa.json()
        if pb.status_code == 200:
            self.pel_b = pb.json()
        self.assert_test("Create marker pelanggan", pa.status_code == 200 and pb.status_code == 200, f"A={pa.status_code} B={pb.status_code}")

        for email, tid, name in (
            (self.user_a_email, self.tenant_a, "Admin A"),
            (self.user_b_email, self.tenant_b, "Admin B"),
        ):
            ru = self.req(
                self.master,
                "POST",
                "/users",
                json={
                    "email": email,
                    "password": self.user_password,
                    "name": name,
                    "role": "ADMIN",
                    "tenantId": tid,
                    "tenantName": name,
                },
            )
            if ru.status_code not in (200, 400):
                self.assert_test(f"Create user {email}", False, f"status={ru.status_code}")
                return False
            self.assert_test(f"Create user {email}", ru.status_code == 200, f"status={ru.status_code}")

        oka, _ = self.login(self.tenant_a_sess, self.user_a_email, self.user_password)
        okb, _ = self.login(self.tenant_b_sess, self.user_b_email, self.user_password)
        self.assert_test("Login tenant A admin", oka)
        self.assert_test("Login tenant B admin", okb)
        return oka and okb

    def section_4_5_tutup_penyusutan(self) -> None:
        print("\n=== 4-5) Tutup buku & penyusutan scoped ===")
        period = datetime.now().strftime("%Y-%m")

        r_need = self.req(self.master, "POST", "/tutup-buku", json={"period": period, "userName": "p5"})
        self.assert_test("MASTER tutup-buku wajib tenantId", r_need.status_code == 400, f"status={r_need.status_code}")
        r_dep = self.req(self.master, "POST", "/penyusutan/run", json={"period": period, "userName": "p5"})
        self.assert_test("MASTER penyusutan wajib tenantId", r_dep.status_code == 400, f"status={r_dep.status_code}")

        if not self.setup_cross_tenant():
            self.mark("4 Tutup buku", "Cross-tenant isolation", Coverage.SKIP, "Setup gagal")
            self.mark("5 Penyusutan", "Cross-tenant isolation", Coverage.SKIP, "Setup gagal")
            return

        prev = (datetime.now().replace(day=1) - timedelta(days=1)).strftime("%Y-%m")
        rc_a = self.req(
            self.tenant_a_sess,
            "POST",
            "/tutup-buku",
            json={"period": prev, "userName": "p5", "tenantId": self.tenant_a},
        )
        self.assert_test(f"ADMIN tenant A tutup-buku {prev}", rc_a.status_code == 200, f"status={rc_a.status_code}")

        log_a = as_list(self.req(self.tenant_a_sess, "GET", "/tutup-buku").json())
        only_a = all((x.get("tenantId") or self.tenant_a) == self.tenant_a for x in log_a)
        self.assert_test("Log tutup-buku tenant A scoped", only_a, f"entries={len(log_a)}")
        self.mark("4 Tutup buku", "ADMIN tutup buku periode", Coverage.COVERED if rc_a.status_code == 200 else Coverage.FAIL)
        self.mark("4 Tutup buku", "GET log hanya tenant sendiri", Coverage.COVERED if only_a else Coverage.FAIL)
        self.mark("4 Tutup buku", "MASTER wajib pilih tenant", Coverage.COVERED if r_need.status_code == 400 else Coverage.FAIL)

        # Asset + depreciation tenant A only
        ra = self.req(
            self.tenant_a_sess,
            "POST",
            "/aset",
            json={"nama": "Aset A", "nilaiAwal": 1200000, "umurBulan": 12, "nilaiResidu": 0},
        )
        self.assert_test("Create aset tenant A", ra.status_code == 200, f"status={ra.status_code}")
        dep_a = self.req(
            self.tenant_a_sess,
            "POST",
            "/penyusutan/run",
            json={"period": period, "userName": "p5", "tenantId": self.tenant_a},
        )
        self.assert_test("Penyusutan tenant A", dep_a.status_code == 200, f"status={dep_a.status_code}")

        logs_b = as_list(self.req(self.tenant_b_sess, "GET", "/penyusutan/log").json())
        leak = any("Aset A" in (x.get("asetNama") or "") for x in logs_b)
        self.assert_test("Penyusutan A tidak bocor ke tenant B log", not leak, f"logB={len(logs_b)}")
        self.mark("5 Penyusutan", "Jurnal/log scoped tenant", Coverage.COVERED if dep_a.status_code == 200 and not leak else Coverage.FAIL)

    def section_6_period_lock(self) -> None:
        print("\n=== 6) Period lock ===")
        prev = (datetime.now().replace(day=1) - timedelta(days=1)).strftime("%Y-%m")
        lock_date = f"{prev}-15"
        today = datetime.now().strftime("%Y-%m-%d")

        # Ensure we actually lock the same tenant used by this test (ADMIN/default).
        # Otherwise posting at lock_date will correctly return 200 (unlocked tenant).
        close_res = self.req(
            self.admin,
            "POST",
            "/tutup-buku",
            json={"period": prev, "userName": "phase5-test"},
        )
        self.assert_test(f"ADMIN tutup-buku default {prev}", close_res.status_code == 200, f"status={close_res.status_code}")

        endpoints = [
            ("jurnal manual", "POST", "/jurnal", {
                "tanggal": lock_date,
                "keterangan": "lock",
                "details": [
                    {"rekeningKode": "10010", "rekeningNama": "Kas", "debet": 1000, "kredit": 0},
                    {"rekeningKode": "30030", "rekeningNama": "Pendapatan", "debet": 0, "kredit": 1000},
                ],
            }),
            ("kas masuk", "POST", "/kas-masuk", {
                "tanggal": lock_date,
                "keterangan": "lock",
                "details": [{"rekeningKode": "30030", "rekeningNama": "Pendapatan", "jumlah": 1000}],
            }),
            ("kas keluar", "POST", "/kas-keluar", {
                "tanggal": lock_date,
                "keterangan": "lock",
                "details": [{"rekeningKode": "40010", "rekeningNama": "Beban", "jumlah": 1000}],
            }),
        ]

        blocked = 0
        for label, method, path, body in endpoints:
            r = self.req(self.admin, method, path, json=body)
            ok = r.status_code == 423
            if ok:
                blocked += 1
            self.assert_test(f"Period lock blocks {label}", ok, f"status={r.status_code}")

        j_ok = self.req(
            self.admin,
            "POST",
            "/jurnal",
            json={
                "tanggal": today,
                "keterangan": "after-lock",
                "details": [
                    {"rekeningKode": "10010", "rekeningNama": "Kas", "debet": 1000, "kredit": 0},
                    {"rekeningKode": "30030", "rekeningNama": "Pendapatan", "debet": 0, "kredit": 1000},
                ],
            },
        )
        self.assert_test("Posting setelah lock masih boleh", j_ok.status_code == 200, f"status={j_ok.status_code}")

        cov = Coverage.COVERED if blocked == len(endpoints) and j_ok.status_code == 200 else Coverage.PARTIAL
        self.mark("6 Period lock", "Posting di periode terkunci -> 423", cov, f"{blocked}/{len(endpoints)} blocked")
        self.mark("6 Period lock", "Posting setelah lock boleh", Coverage.COVERED if j_ok.status_code == 200 else Coverage.FAIL)

    def section_7_stok_lokasi(self) -> None:
        print("\n=== 7) Stok per lokasi ===")
        rp = self.req(self.admin, "GET", "/products?limit=1")
        products = as_list(rp.json())
        if not products:
            self.mark("7 Stok lokasi", "Semua sub-item", Coverage.SKIP, "Tidak ada produk")
            return
        p = products[0]
        rl = self.req(self.admin, "GET", "/lokasi")
        lokasi = as_list(rl.json())
        if len(lokasi) < 2:
            self.mark("7 Stok lokasi", "Transfer antar lokasi", Coverage.SKIP, "Lokasi < 2")
            return

        before = float(p.get("stok", 0))
        asal, tujuan = lokasi[0], lokasi[1]
        rt = self.req(
            self.admin,
            "POST",
            "/stok/transfer",
            json={
                "lokasiAsal": asal["kode"],
                "lokasiAsalNama": asal.get("nama", asal["kode"]),
                "lokasiTujuan": tujuan["kode"],
                "lokasiTujuanNama": tujuan.get("nama", tujuan["kode"]),
                "items": [{"stokId": p["id"], "kode": p.get("kode"), "qty": 1, "hargaBeli": p.get("hargaBeli", 0)}],
                "userName": "p5",
            },
        )
        self.assert_test("Transfer valid sukses", rt.status_code == 200, f"status={rt.status_code}")

        ro = self.req(
            self.admin,
            "POST",
            "/stok/transfer",
            json={
                "lokasiAsal": asal["kode"],
                "lokasiTujuan": tujuan["kode"],
                "items": [{"stokId": p["id"], "kode": p.get("kode"), "qty": 999999}],
                "userName": "p5",
            },
        )
        self.assert_test("Transfer qty berlebih ditolak", ro.status_code == 400, f"status={ro.status_code}")

        rp2 = self.req(self.admin, "GET", f"/products?q={p.get('kode','')}&limit=5")
        updated = next((x for x in as_list(rp2.json()) if x.get("id") == p["id"]), None)
        same_total = updated and abs(float(updated.get("stok", 0)) - before) < 1e-6
        self.assert_test("Total products.stok tidak berubah saat transfer", same_total)

        # Per-location adjustment verification from stock card rows
        adj = self.req(
            self.admin,
            "POST",
            "/stok/penyesuaian",
            json={
                "lokasi": "L002 - Gudang",
                "keterangan": "phase5 adjust lokasi",
                "items": [{"stokId": p["id"], "kode": p.get("kode"), "qtyAktual": 5}],
            },
        )
        self.assert_test("Penyesuaian lokasi L002 sukses", adj.status_code == 200, f"status={adj.status_code}")
        kartu = as_dict(self.req(self.admin, "GET", f"/stok/kartu?productId={p['id']}").json())
        rows = kartu.get("rows", []) if isinstance(kartu, dict) else []
        has_adj_l2 = any((r.get("sourceType") == "PENYESUAIAN" and "L002" in str(r.get("lokasi", ""))) for r in rows)
        self.assert_test("Kartu stok mencatat penyesuaian lokasi L002", has_adj_l2)

        # Kasir deduct from active location (L001) check via stock card lokasi
        trx = self.req(
            self.admin,
            "POST",
            "/transactions",
            json={
                "noNota": f"P5LOC{self.ts}",
                "kasirName": "p5",
                "mode": "KASIR",
                "paymentMethod": "TUNAI",
                "lokasi": "L001 - Toko Utama",
                "items": [{
                    "stokId": p["id"],
                    "kode": p.get("kode"),
                    "nama": p.get("nama"),
                    "satuan": p.get("satuan", "PCS"),
                    "qty": 1,
                    "harga": p.get("hargaEcer", 1000),
                    "diskon": 0,
                    "hargaBeli": p.get("hargaBeli", 0),
                }],
                "bayar": 100000,
            },
        )
        self.assert_test("Kasir transaksi lokasi L001 sukses", trx.status_code == 200, f"status={trx.status_code}")
        kartu2 = as_dict(self.req(self.admin, "GET", f"/stok/kartu?productId={p['id']}").json())
        rows2 = kartu2.get("rows", []) if isinstance(kartu2, dict) else []
        has_sell_l1 = any((r.get("sourceType") == "PENJUALAN" and "L001" in str(r.get("lokasi", ""))) for r in rows2)
        self.assert_test("Kartu stok penjualan tercatat di lokasi L001", has_sell_l1)

        self.mark("7 Stok lokasi", "Transfer sukses", Coverage.COVERED if rt.status_code == 200 else Coverage.FAIL)
        self.mark("7 Stok lokasi", "Transfer oversell ditolak", Coverage.COVERED if ro.status_code == 400 else Coverage.FAIL)
        self.mark("7 Stok lokasi", "Total stok = jumlah lokasi", Coverage.COVERED if same_total else Coverage.PARTIAL)
        self.mark("7 Stok lokasi", "Penyesuaian per lokasi", Coverage.COVERED if adj.status_code == 200 and has_adj_l2 else Coverage.PARTIAL)
        self.mark("7 Stok lokasi", "Kasir kurangi stok lokasi aktif", Coverage.COVERED if trx.status_code == 200 and has_sell_l1 else Coverage.PARTIAL)

    def section_8_idor_cross_tenant(self) -> None:
        print("\n=== 8) Scoped lookup / IDOR ===")
        if not self.prod_a.get("id") or not self.prod_b.get("id"):
            self.mark("8 IDOR", "Cross-tenant access", Coverage.SKIP, "Produk marker belum dibuat")
            return

        r_ab = self.req(self.tenant_a_sess, "PUT", f"/products/{self.prod_b['id']}", json={"nama": "hack"})
        r_ba = self.req(self.tenant_b_sess, "PUT", f"/products/{self.prod_a['id']}", json={"nama": "hack"})
        blocked = r_ab.status_code in (403, 404) and r_ba.status_code in (403, 404)
        self.assert_test("IDOR PUT produk lintas tenant ditolak", blocked, f"A->B={r_ab.status_code} B->A={r_ba.status_code}")

        lista = as_list(self.req(self.tenant_a_sess, "GET", "/products?limit=500").json())
        codes_a = {x.get("kode") for x in lista}
        leak = f"P5B-{self.ts}" in codes_a
        self.assert_test("List produk tenant A tidak mengandung kode tenant B", not leak)

        # Supplier/pelanggan detail cross-tenant should be blocked too
        s_ab = self.req(self.tenant_a_sess, "PUT", f"/supplier/{self.sup_b.get('id', 'none')}", json={"nama": "hack"})
        s_ba = self.req(self.tenant_b_sess, "PUT", f"/supplier/{self.sup_a.get('id', 'none')}", json={"nama": "hack"})
        p_ab = self.req(self.tenant_a_sess, "PUT", f"/pelanggan/{self.pel_b.get('id', 'none')}", json={"nama": "hack"})
        p_ba = self.req(self.tenant_b_sess, "PUT", f"/pelanggan/{self.pel_a.get('id', 'none')}", json={"nama": "hack"})
        cross_blocked = all(r.status_code in (403, 404) for r in (s_ab, s_ba, p_ab, p_ba))
        self.assert_test(
            "IDOR supplier/pelanggan lintas tenant ditolak",
            cross_blocked,
            f"sAB={s_ab.status_code} sBA={s_ba.status_code} pAB={p_ab.status_code} pBA={p_ba.status_code}",
        )

        self.mark("8 IDOR", "ID produk tenant lain tidak bisa diubah", Coverage.COVERED if blocked else Coverage.FAIL)
        self.mark("8 IDOR", "List tidak bocor tenant lain", Coverage.COVERED if not leak else Coverage.FAIL)
        self.mark("8 IDOR", "Pelanggan/supplier/lokasi detail", Coverage.COVERED if cross_blocked else Coverage.PARTIAL)

    def section_9_regression(self) -> None:
        print("\n=== 9) Regression ringkas ===")
        rp = self.req(self.admin, "GET", "/products?limit=1")
        products = as_list(rp.json())
        if not products:
            self.mark("9 Regression", "Transaksi tunai", Coverage.SKIP)
            return
        p = products[0]
        no_nota = f"P5V2{self.ts}"
        rt = self.req(
            self.admin,
            "POST",
            "/transactions",
            json={
                "noNota": no_nota,
                "kasirName": "p5",
                "mode": "KASIR",
                "paymentMethod": "TUNAI",
                "lokasi": "L001 - Toko Utama",
                "items": [{
                    "stokId": p["id"],
                    "kode": p.get("kode"),
                    "nama": p.get("nama"),
                    "satuan": p.get("satuan", "PCS"),
                    "qty": 1,
                    "harga": p.get("hargaEcer", 1000),
                    "diskon": 0,
                    "hargaBeli": p.get("hargaBeli", 0),
                }],
                "bayar": 100000,
            },
        )
        self.assert_test("Transaksi tunai", rt.status_code == 200, f"status={rt.status_code}")

        j = as_list(self.req(self.admin, "GET", "/jurnal?sourceType=AUTO_KASIR").json())
        has_j = any((x.get("keterangan") or "").find(no_nota) >= 0 for x in j)
        self.assert_test("Jurnal auto kasir", has_j)

        self.mark("9 Regression", "Transaksi tunai + jurnal", Coverage.COVERED if rt.status_code == 200 and has_j else Coverage.PARTIAL)

        # Kredit + piutang + pelunasan
        pel = self.req(self.admin, "POST", "/pelanggan", json={"nama": f"P5 Kredit {self.ts}"})
        pel_ok = pel.status_code == 200
        pel_id = pel.json().get("id") if pel_ok else None
        trxk = self.req(
            self.admin,
            "POST",
            "/transactions",
            json={
                "noNota": f"P5K{self.ts}",
                "kasirName": "p5",
                "mode": "KREDIT",
                "pelangganId": pel_id,
                "jatuhTempo": (datetime.now() + timedelta(days=7)).isoformat(),
                "lokasi": "L001 - Toko Utama",
                "items": [{
                    "stokId": p["id"], "kode": p.get("kode"), "nama": p.get("nama"),
                    "satuan": p.get("satuan", "PCS"), "qty": 1, "harga": p.get("hargaEcer", 1000),
                    "diskon": 0, "hargaBeli": p.get("hargaBeli", 0),
                }],
                "bayar": 0,
            },
        ) if pel_ok else None
        self.assert_test("Transaksi kredit", bool(trxk and trxk.status_code == 200), f"status={trxk.status_code if trxk else 'skip'}")
        piutang_list = as_list(self.req(self.admin, "GET", "/piutang").json())
        piu = next((x for x in piutang_list if x.get("noNota") == f"P5K{self.ts}"), None)
        pay_ok = False
        if piu:
            pay = self.req(self.admin, "POST", f"/piutang/{piu['id']}/bayar", json={"amount": 1000, "metode": "TUNAI", "userName": "p5"})
            pay_ok = pay.status_code == 200
        self.assert_test("Pelunasan piutang", pay_ok)

        # Pembelian hutang + pelunasan hutang
        sup = self.req(self.admin, "POST", "/supplier", json={"nama": f"P5 Supplier {self.ts}"})
        sup_ok = sup.status_code == 200
        sup_id = sup.json().get("id") if sup_ok else None
        beli = self.req(
            self.admin,
            "POST",
            "/pembelian",
            json={
                "supplierId": sup_id, "tunai": False, "userName": "p5",
                "items": [{"stokId": p["id"], "kode": p.get("kode"), "qty": 2, "harga": p.get("hargaBeli", 1000) or 1000}],
            },
        ) if sup_ok else None
        self.assert_test("Pembelian kredit/hutang", bool(beli and beli.status_code == 200), f"status={beli.status_code if beli else 'skip'}")
        hutang_list = as_list(self.req(self.admin, "GET", "/hutang").json())
        ht = next((x for x in hutang_list if x.get("noPembelian") == (beli.json().get("noPembelian") if beli and beli.status_code == 200 else None)), None)
        hutang_pay_ok = False
        if ht:
            hp = self.req(self.admin, "POST", f"/hutang/{ht['id']}/bayar", json={"amount": 1000, "metode": "TUNAI", "userName": "p5"})
            hutang_pay_ok = hp.status_code == 200
        self.assert_test("Pelunasan hutang", hutang_pay_ok)

        # Retur (jual + beli)
        retur_jual_ok = False
        if trxk and trxk.status_code == 200:
            rj = self.req(
                self.admin,
                "POST",
                "/retur-penjualan",
                json={
                    "noNotaAsal": f"P5K{self.ts}",
                    "items": [{"stokId": p["id"], "kode": p.get("kode"), "qty": 1, "harga": p.get("hargaEcer", 1000), "hargaBeli": p.get("hargaBeli", 0)}],
                    "userName": "p5",
                },
            )
            retur_jual_ok = rj.status_code == 200
        self.assert_test("Retur penjualan", retur_jual_ok)

        retur_beli_ok = False
        if beli and beli.status_code == 200:
            rb = self.req(
                self.admin,
                "POST",
                "/retur-pembelian",
                json={
                    "noPembelianAsal": beli.json().get("noPembelian"),
                    "items": [{"stokId": p["id"], "kode": p.get("kode"), "qty": 1, "harga": p.get("hargaBeli", 1000) or 1000}],
                    "userName": "p5",
                },
            )
            retur_beli_ok = rb.status_code == 200
        self.assert_test("Retur pembelian", retur_beli_ok)

        flow_ok = all([pel_ok, bool(trxk and trxk.status_code == 200), bool(beli and beli.status_code == 200), retur_jual_ok, retur_beli_ok])
        self.mark("9 Regression", "Kredit/piutang, pembelian, retur", Coverage.COVERED if flow_ok else Coverage.PARTIAL)
        self.mark("9 Regression", "Pelunasan hutang/piutang", Coverage.COVERED if pay_ok and hutang_pay_ok else Coverage.PARTIAL)

    def section_10_mongo(self) -> None:
        print("\n=== 10) Mongo integrity ===")
        if not RUN_MONGO:
            self.mark("10 Mongo", "tenantId di koleksi", Coverage.SKIP, "RUN_MONGO=0")
            return

        script = os.path.join(os.path.dirname(__file__), "phase5_mongo_integrity.mjs")
        try:
            proc = subprocess.run(
                ["node", script, self.tenant_a, self.tenant_b],
                cwd=os.path.dirname(script),
                capture_output=True,
                text=True,
                timeout=60,
            )
            out = proc.stdout.strip() or proc.stderr.strip()
            report = json.loads(out) if out.startswith("{") else {"ok": False, "error": out[:200]}
            ok = proc.returncode == 0 and report.get("ok", False)
            missing_total = sum(
                v.get("missingTenantId", 0)
                for k, v in report.get("collections", {}).items()
                if isinstance(v, dict)
            )
            self.assert_test("Mongo integrity", ok, f"missingTenantId total={missing_total}")
            self.mark("10 Mongo", "Koleksi operasional punya tenantId", Coverage.COVERED if ok else Coverage.FAIL)
            self.mark("10 Mongo", "stok_lokasi terisi", Coverage.COVERED if report.get("stokLokasi", {}).get("rows", 0) > 0 else Coverage.PARTIAL)
        except Exception as e:
            self.assert_test("Mongo integrity", False, str(e))
            self.mark("10 Mongo", "Koleksi operasional punya tenantId", Coverage.SKIP, str(e))

    def cleanup(self) -> None:
        if not CLEANUP_TENANTS:
            return
        print("\n=== Cleanup test tenants ===")
        for tid in (self.tenant_a, self.tenant_b):
            r = self.req(self.master, "DELETE", f"/tenants/{tid}?force=true")
            self.assert_test(f"Delete tenant {tid}", r.status_code == 200, f"status={r.status_code}")

    def finish(self) -> int:
        self.cleanup()
        passed = sum(1 for _, ok, _ in self.assertions if ok)
        failed = sum(1 for _, ok, _ in self.assertions if not ok)
        print(f"\n=== ASSERTIONS: {passed} passed, {failed} failed ===")
        self.print_matrix()
        return 0 if failed == 0 else 1

    def print_matrix(self) -> None:
        print("\n=== CHECKLIST MATRIX (Phase 5) ===")
        print(f"{'Section':<14} {'Item':<42} {'Coverage':<10} Note")
        print("-" * 100)
        for c in self.checklist:
            print(f"{c.section:<14} {c.item[:42]:<42} {c.coverage.value:<10} {c.note[:40]}")

        counts: dict[str, int] = {}
        for c in self.checklist:
            counts[c.coverage.value] = counts.get(c.coverage.value, 0) + 1
        print("\nCoverage summary:", ", ".join(f"{k}={v}" for k, v in sorted(counts.items())))


def main() -> int:
    global BASE_APP_URL, BASE_API_URL
    BASE_APP_URL, BASE_API_URL = resolve_runtime_urls()
    ensure_server_or_exit(BASE_APP_URL, BASE_API_URL)
    return Phase5V2Runner().run()


if __name__ == "__main__":
    sys.exit(main())

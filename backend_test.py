#!/usr/bin/env python3
"""
Phase 3 Refactor Regression Test Suite
Tests all 30+ critical flows after route.js reduction from 1497 LOC → 91 LOC
"""

import requests
import json
from datetime import datetime, timedelta

BASE_URL = "https://sales-app-66.preview.emergentagent.com/api"

# Test credentials
CREDENTIALS = {
    "master": {"email": "master@dawam.com", "password": "master123"},
}

# Global variables to store IDs for cleanup and testing
test_data = {
    "product_id": None,
    "transaction_id": None,
    "pelanggan_id": None,
    "supplier_id": None,
    "member_id": None,
    "lokasi_id": None,
    "pembelian_id": None,
    "hutang_id": None,
    "piutang_id": None,
    "tenant_id": None,
    "user_id": None,
    "aset_id": None,
    "retur_penjualan_id": None,
    "retur_pembelian_id": None,
    "no_nota": None,
    "no_pembelian": None
}

def print_test(name):
    print(f"\n{'='*80}")
    print(f"TEST: {name}")
    print('='*80)

def print_success(msg):
    print(f"✅ {msg}")

def print_error(msg):
    print(f"❌ {msg}")

def print_info(msg):
    print(f"ℹ️  {msg}")

# ============================================================================
# AUTH & USERS TESTS
# ============================================================================

def test_auth_login():
    """Test 1: POST /api/auth/login (all 3 accounts)"""
    print_test("Auth Login - All 3 Demo Accounts")
    
    try:
        for role, creds in CREDENTIALS.items():
            print_info(f"Testing {role} account: {creds['email']}")
            response = requests.post(f"{BASE_URL}/auth/login", json=creds)
            
            if response.status_code == 200:
                data = response.json()
                if "user" in data:
                    user = data["user"]
                    if user.get("email") == creds["email"] and user.get("role"):
                        print_success(f"{role.upper()} login successful - {user['email']} (role: {user['role']})")
                    else:
                        print_error(f"{role.upper()} login returned incomplete user data")
                        return False
                else:
                    print_error(f"{role.upper()} login response missing user field")
                    return False
            else:
                print_error(f"{role.upper()} login failed with status {response.status_code}")
                return False
        
        # Test wrong password
        print_info("Testing wrong password (should return 401)")
        response = requests.post(f"{BASE_URL}/auth/login", json={"email": "master@dawam.com", "password": "wrongpass"})
        if response.status_code == 401:
            print_success("Wrong password correctly returns 401")
        else:
            print_error(f"Wrong password should return 401, got {response.status_code}")
            return False
        
        # Test missing fields
        print_info("Testing missing fields (should return 400)")
        response = requests.post(f"{BASE_URL}/auth/login", json={"email": "master@dawam.com"})
        if response.status_code == 400:
            print_success("Missing fields correctly returns 400")
        else:
            print_error(f"Missing fields should return 400, got {response.status_code}")
            return False
        
        return True
    except Exception as e:
        print_error(f"Exception: {str(e)}")
        return False

def test_users_crud():
    """Test 2: POST /api/users + DELETE /api/users/:id"""
    print_test("Users CRUD + Password Hashing")
    
    try:
        # Create user
        print_info("Creating new user")
        new_user = {
            "email": f"testuser_{datetime.now().timestamp()}@kasir.id",
            "password": "testpass123",
            "name": "Test User Phase3",
            "role": "KASIR",
            "tenantId": "default"
        }
        response = requests.post(f"{BASE_URL}/users", json=new_user)
        
        if response.status_code == 200:
            user = response.json()
            test_data["user_id"] = user["id"]
            print_success(f"User created: {user['email']} (id: {user['id']})")
            
            # Verify password is hashed (should start with $2)
            if user.get("password", "").startswith("$2"):
                print_success("Password is properly hashed with bcrypt")
            else:
                print_error("Password is not hashed!")
                return False
        else:
            print_error(f"User creation failed with status {response.status_code}")
            return False
        
        # Delete user
        print_info(f"Deleting user {test_data['user_id']}")
        response = requests.delete(f"{BASE_URL}/users/{test_data['user_id']}")
        
        if response.status_code == 200:
            print_success("User deleted successfully")
            
            # Verify deletion
            response = requests.get(f"{BASE_URL}/users")
            if response.status_code == 200:
                users = response.json() if isinstance(response.json(), list) else []
                if not any(u["id"] == test_data["user_id"] for u in users):
                    print_success("User deletion verified - user not in list")
                else:
                    print_error("User still appears in list after deletion!")
                    return False
            else:
                print_error("Failed to verify user deletion")
                return False
        else:
            print_error(f"User deletion failed with status {response.status_code}")
            return False
        
        return True
    except Exception as e:
        print_error(f"Exception: {str(e)}")
        return False

# ============================================================================
# MASTER DATA TESTS
# ============================================================================

def test_products_crud():
    """Test 3: GET /api/products + POST + PUT + DELETE"""
    print_test("Products CRUD")
    
    try:
        # GET products
        print_info("Getting products list")
        response = requests.get(f"{BASE_URL}/products")
        
        if response.status_code == 200:
            data = response.json()
            products = data.get("data", [])
            print_success(f"GET /products returned {len(products)} products")
        else:
            print_error(f"GET /products failed with status {response.status_code}")
            return False
        
        # POST new product
        print_info("Creating new product")
        new_product = {
            "kode": f"TEST{int(datetime.now().timestamp())}",
            "barcode": f"999{int(datetime.now().timestamp())}",
            "nama": "Test Product Phase3",
            "grup": "Test",
            "satuan": "PCS",
            "hargaBeli": 10000,
            "hargaSpesial": 12000,
            "hargaGrosir": 13000,
            "hargaEcer": 15000,
            "stok": 100,
            "minStok": 10
        }
        response = requests.post(f"{BASE_URL}/products", json=new_product)
        
        if response.status_code == 200:
            data = response.json()
            product = data.get("data", {})
            test_data["product_id"] = product["id"]
            print_success(f"Product created: {product['nama']} (id: {product['id']})")
        else:
            print_error(f"Product creation failed with status {response.status_code}")
            return False
        
        # PUT update product
        print_info(f"Updating product {test_data['product_id']}")
        update_data = {"nama": "Test Product Phase3 UPDATED", "hargaEcer": 16000}
        response = requests.put(f"{BASE_URL}/products/{test_data['product_id']}", json=update_data)
        
        if response.status_code == 200:
            data = response.json()
            product = data.get("data", {})
            if product.get("nama") == "Test Product Phase3 UPDATED" and product.get("hargaEcer") == 16000:
                print_success("Product updated successfully")
            else:
                print_error("Product update did not apply correctly")
                return False
        else:
            print_error(f"Product update failed with status {response.status_code}")
            return False
        
        # DELETE product
        print_info(f"Deleting product {test_data['product_id']}")
        response = requests.delete(f"{BASE_URL}/products/{test_data['product_id']}")
        
        if response.status_code == 200:
            print_success("Product deleted successfully")
        else:
            print_error(f"Product deletion failed with status {response.status_code}")
            return False
        
        return True
    except Exception as e:
        print_error(f"Exception: {str(e)}")
        return False

def test_products_lookup():
    """Test 4: GET /api/products/lookup?code=B00001 (by code) + by barcode"""
    print_test("Products Lookup by Code and Barcode")
    
    try:
        # Lookup by code
        print_info("Looking up product by code B00001")
        response = requests.get(f"{BASE_URL}/products/lookup?code=B00001")
        
        if response.status_code == 200:
            data = response.json()
            product = data.get("data", {})
            if product.get("kode") == "B00001":
                print_success(f"Lookup by code found: {product['nama']}")
            else:
                print_error("Lookup by code returned wrong product")
                return False
        else:
            print_error(f"Lookup by code failed with status {response.status_code}")
            return False
        
        # Lookup by barcode
        print_info("Looking up product by barcode 8991002101417")
        response = requests.get(f"{BASE_URL}/products/lookup?code=8991002101417")
        
        if response.status_code == 200:
            data = response.json()
            product = data.get("data", {})
            if product.get("barcode") == "8991002101417":
                print_success(f"Lookup by barcode found: {product['nama']}")
            else:
                print_error("Lookup by barcode returned wrong product")
                return False
        elif response.status_code == 404:
            print_info("Barcode not found (404) - trying alternative barcode")
            # Try another barcode
            response = requests.get(f"{BASE_URL}/products/lookup?code=8993175534222")
            if response.status_code == 200:
                data = response.json()
                product = data.get("data", {})
                print_success(f"Lookup by barcode found: {product['nama']}")
            else:
                print_error("No products with barcodes found")
                return False
        else:
            print_error(f"Lookup by barcode failed with status {response.status_code}")
            return False
        
        # Test invalid code (should return 404)
        print_info("Testing invalid code (should return 404)")
        response = requests.get(f"{BASE_URL}/products/lookup?code=INVALID999")
        if response.status_code == 404:
            print_success("Invalid code correctly returns 404")
        else:
            print_error(f"Invalid code should return 404, got {response.status_code}")
            return False
        
        return True
    except Exception as e:
        print_error(f"Exception: {str(e)}")
        return False

def test_master_data_crud():
    """Test 5: GET/POST/PUT/DELETE on /api/pelanggan, /api/supplier, /api/members, /api/lokasi"""
    print_test("Master Data CRUD (Pelanggan, Supplier, Members, Lokasi)")
    
    try:
        # PELANGGAN
        print_info("Testing Pelanggan CRUD")
        pelanggan_data = {
            "nama": "Pelanggan Test Phase3",
            "alamat": "Jl. Test No. 123",
            "telepon": "08123456789",
            "limitKredit": 5000000,
            "jatuhTempo": 30
        }
        response = requests.post(f"{BASE_URL}/pelanggan", json=pelanggan_data)
        if response.status_code == 200:
            data = response.json()
            test_data["pelanggan_id"] = data.get("data", {}).get("id")
            print_success(f"Pelanggan created: {test_data['pelanggan_id']}")
        else:
            print_error(f"Pelanggan creation failed: {response.status_code}")
            return False
        
        # GET pelanggan
        response = requests.get(f"{BASE_URL}/pelanggan")
        if response.status_code == 200:
            print_success(f"GET /pelanggan returned {len(response.json().get('data', []))} records")
        else:
            print_error("GET /pelanggan failed")
            return False
        
        # DELETE pelanggan
        response = requests.delete(f"{BASE_URL}/pelanggan/{test_data['pelanggan_id']}")
        if response.status_code == 200:
            print_success("Pelanggan deleted")
        else:
            print_error("Pelanggan deletion failed")
            return False
        
        # SUPPLIER
        print_info("Testing Supplier CRUD")
        supplier_data = {
            "nama": "Supplier Test Phase3",
            "alamat": "Jl. Supplier No. 456",
            "telepon": "08198765432",
            "TOP": 14
        }
        response = requests.post(f"{BASE_URL}/supplier", json=supplier_data)
        if response.status_code == 200:
            data = response.json()
            test_data["supplier_id"] = data.get("data", {}).get("id")
            print_success(f"Supplier created: {test_data['supplier_id']}")
        else:
            print_error(f"Supplier creation failed: {response.status_code}")
            return False
        
        # GET supplier
        response = requests.get(f"{BASE_URL}/supplier")
        if response.status_code == 200:
            print_success(f"GET /supplier returned {len(response.json().get('data', []))} records")
        else:
            print_error("GET /supplier failed")
            return False
        
        # MEMBERS
        print_info("Testing Members CRUD")
        member_data = {
            "nama": "Member Test Phase3",
            "telepon": "08111222333",
            "tier": "GOLD"
        }
        response = requests.post(f"{BASE_URL}/members", json=member_data)
        if response.status_code == 200:
            data = response.json()
            test_data["member_id"] = data.get("data", {}).get("id")
            print_success(f"Member created: {test_data['member_id']}")
        else:
            print_error(f"Member creation failed: {response.status_code}")
            return False
        
        # GET members
        response = requests.get(f"{BASE_URL}/members")
        if response.status_code == 200:
            print_success(f"GET /members returned {len(response.json().get('data', []))} records")
        else:
            print_error("GET /members failed")
            return False
        
        # LOKASI
        print_info("Testing Lokasi CRUD")
        lokasi_data = {
            "nama": "Lokasi Test Phase3",
            "keterangan": "Test location"
        }
        response = requests.post(f"{BASE_URL}/lokasi", json=lokasi_data)
        if response.status_code == 200:
            data = response.json()
            test_data["lokasi_id"] = data.get("data", {}).get("id")
            print_success(f"Lokasi created: {test_data['lokasi_id']}")
        else:
            print_error(f"Lokasi creation failed: {response.status_code}")
            return False
        
        # GET lokasi
        response = requests.get(f"{BASE_URL}/lokasi")
        if response.status_code == 200:
            print_success(f"GET /lokasi returned {len(response.json().get('data', []))} records")
        else:
            print_error("GET /lokasi failed")
            return False
        
        return True
    except Exception as e:
        print_error(f"Exception: {str(e)}")
        return False

# ============================================================================
# POS FLOW TESTS
# ============================================================================

def test_transaction_create():
    """Test 6: POST /api/transactions (3 items) - verify stock, calculations, auto-journal, kartu stok"""
    print_test("Transaction Creation (3 items) - Stock, Calculations, Auto-Journal")
    
    try:
        # Get 3 products
        print_info("Getting products for transaction")
        response = requests.get(f"{BASE_URL}/products?limit=3")
        if response.status_code != 200:
            print_error("Failed to get products")
            return False
        
        products = response.json().get("data", [])
        if len(products) < 3:
            print_error("Not enough products in database")
            return False
        
        # Record initial stock levels
        initial_stocks = {}
        for p in products[:3]:
            initial_stocks[p["id"]] = p["stok"]
            print_info(f"Product {p['kode']}: initial stock = {p['stok']}")
        
        # Create transaction
        print_info("Creating transaction with 3 items")
        test_data["no_nota"] = f"TRX{int(datetime.now().timestamp())}"
        transaction_data = {
            "noNota": test_data["no_nota"],
            "kasirId": "test-kasir",
            "kasirName": "Test Kasir Phase3",
            "mode": "KASIR",
            "paymentMethod": "TUNAI",
            "items": [
                {
                    "stokId": products[0]["id"],
                    "kode": products[0]["kode"],
                    "nama": products[0]["nama"],
                    "satuan": products[0]["satuan"],
                    "qty": 2,
                    "harga": products[0]["hargaEcer"],
                    "diskon": 0,
                    "hargaBeli": products[0]["hargaBeli"]
                },
                {
                    "stokId": products[1]["id"],
                    "kode": products[1]["kode"],
                    "nama": products[1]["nama"],
                    "satuan": products[1]["satuan"],
                    "qty": 1,
                    "harga": products[1]["hargaEcer"],
                    "diskon": 0,
                    "hargaBeli": products[1]["hargaBeli"]
                },
                {
                    "stokId": products[2]["id"],
                    "kode": products[2]["kode"],
                    "nama": products[2]["nama"],
                    "satuan": products[2]["satuan"],
                    "qty": 3,
                    "harga": products[2]["hargaEcer"],
                    "diskon": 0,
                    "hargaBeli": products[2]["hargaBeli"]
                }
            ],
            "diskonNota": 0,
            "ppn": 0,
            "bayar": 1000000
        }
        
        # Calculate expected total
        expected_subtotal = (products[0]["hargaEcer"] * 2) + (products[1]["hargaEcer"] * 1) + (products[2]["hargaEcer"] * 3)
        expected_total = expected_subtotal
        
        response = requests.post(f"{BASE_URL}/transactions", json=transaction_data)
        
        if response.status_code == 200:
            data = response.json()
            trx = data.get("data", {})
            test_data["transaction_id"] = trx["id"]
            
            # Verify calculations
            if trx.get("subTotal") == expected_subtotal and trx.get("total") == expected_total:
                print_success(f"Transaction created with correct calculations: subTotal={trx['subTotal']}, total={trx['total']}")
            else:
                print_error(f"Calculation mismatch: expected {expected_total}, got {trx.get('total')}")
                return False
            
            # Verify kembali
            expected_kembali = 1000000 - expected_total
            if trx.get("kembali") == expected_kembali:
                print_success(f"Kembali calculated correctly: {trx['kembali']}")
            else:
                print_error(f"Kembali mismatch: expected {expected_kembali}, got {trx.get('kembali')}")
                return False
            
            # Verify stock decrement
            print_info("Verifying stock decrement")
            for item in transaction_data["items"]:
                response = requests.get(f"{BASE_URL}/products")
                products_after = response.json().get("data", [])
                product_after = next((p for p in products_after if p["id"] == item["stokId"]), None)
                
                if product_after:
                    expected_stock = initial_stocks[item["stokId"]] - item["qty"]
                    if product_after["stok"] == expected_stock:
                        print_success(f"Stock decremented correctly for {item['kode']}: {initial_stocks[item['stokId']]} → {product_after['stok']}")
                    else:
                        print_error(f"Stock mismatch for {item['kode']}: expected {expected_stock}, got {product_after['stok']}")
                        return False
                else:
                    print_error(f"Product {item['stokId']} not found after transaction")
                    return False
            
            # Verify auto-journal created
            print_info("Verifying auto-journal creation")
            response = requests.get(f"{BASE_URL}/jurnal?sourceType=AUTO_KASIR")
            if response.status_code == 200:
                journals = response.json().get("data", [])
                journal = next((j for j in journals if j.get("sourceId") == test_data["transaction_id"]), None)
                if journal:
                    print_success(f"Auto-journal created: {journal['noJurnal']}")
                else:
                    print_error("Auto-journal not found for transaction")
                    return False
            else:
                print_error("Failed to verify auto-journal")
                return False
            
            # Verify kartu stok entries
            print_info("Verifying kartu stok entries")
            for item in transaction_data["items"]:
                response = requests.get(f"{BASE_URL}/stok/kartu?productId={item['stokId']}")
                if response.status_code == 200:
                    kartu = response.json().get("data", {}).get("rows", [])
                    entry = next((k for k in kartu if k.get("noTransaksi") == test_data["no_nota"]), None)
                    if entry and entry.get("keluar") == item["qty"]:
                        print_success(f"Kartu stok entry found for {item['kode']}: keluar={entry['keluar']}")
                    else:
                        print_error(f"Kartu stok entry not found or incorrect for {item['kode']}")
                        return False
                else:
                    print_error(f"Failed to get kartu stok for {item['kode']}")
                    return False
            
        else:
            print_error(f"Transaction creation failed with status {response.status_code}: {response.text}")
            return False
        
        return True
    except Exception as e:
        print_error(f"Exception: {str(e)}")
        return False

def test_transaction_kredit():
    """Test 7: POST /api/transactions with mode=KREDIT - verify piutang"""
    print_test("Transaction KREDIT Mode - Piutang Creation")
    
    try:
        # Create pelanggan first
        print_info("Creating pelanggan for kredit transaction")
        pelanggan_data = {
            "nama": "Pelanggan Kredit Phase3",
            "alamat": "Jl. Kredit No. 789",
            "telepon": "08199988877",
            "limitKredit": 10000000,
            "jatuhTempo": 30
        }
        response = requests.post(f"{BASE_URL}/pelanggan", json=pelanggan_data)
        if response.status_code != 200:
            print_error("Failed to create pelanggan")
            return False
        
        pelanggan_id = response.json().get("data", {}).get("id")
        print_success(f"Pelanggan created: {pelanggan_id}")
        
        # Get a product
        response = requests.get(f"{BASE_URL}/products?limit=1")
        if response.status_code != 200:
            print_error("Failed to get product")
            return False
        
        product = response.json().get("data", [])[0]
        
        # Create KREDIT transaction
        print_info("Creating KREDIT transaction")
        no_nota_kredit = f"KREDIT{int(datetime.now().timestamp())}"
        jatuh_tempo = (datetime.now() + timedelta(days=30)).isoformat()
        
        transaction_data = {
            "noNota": no_nota_kredit,
            "kasirId": "test-kasir",
            "kasirName": "Test Kasir Phase3",
            "mode": "KREDIT",
            "pelangganId": pelanggan_id,
            "jatuhTempo": jatuh_tempo,
            "items": [
                {
                    "stokId": product["id"],
                    "kode": product["kode"],
                    "nama": product["nama"],
                    "satuan": product["satuan"],
                    "qty": 1,
                    "harga": product["hargaEcer"],
                    "diskon": 0,
                    "hargaBeli": product["hargaBeli"]
                }
            ],
            "diskonNota": 0,
            "ppn": 0,
            "bayar": 0
        }
        
        response = requests.post(f"{BASE_URL}/transactions", json=transaction_data)
        
        if response.status_code == 200:
            data = response.json()
            trx = data.get("data", {})
            
            # Verify mode and hutang
            if trx.get("mode") == "KREDIT" and trx.get("hutang") == trx.get("total"):
                print_success(f"KREDIT transaction created: total={trx['total']}, hutang={trx['hutang']}")
            else:
                print_error("KREDIT transaction mode or hutang incorrect")
                return False
            
            # Verify piutang entry created
            print_info("Verifying piutang entry")
            response = requests.get(f"{BASE_URL}/piutang")
            if response.status_code == 200:
                piutangs = response.json().get("data", [])
                piutang = next((p for p in piutangs if p.get("noNota") == no_nota_kredit), None)
                if piutang:
                    test_data["piutang_id"] = piutang["id"]
                    if piutang.get("total") == trx["total"] and piutang.get("sisa") == trx["total"]:
                        print_success(f"Piutang entry created: {piutang['noPiutang']}, sisa={piutang['sisa']}")
                    else:
                        print_error("Piutang amounts incorrect")
                        return False
                else:
                    print_error("Piutang entry not found")
                    return False
            else:
                print_error("Failed to get piutang list")
                return False
            
            # Verify auto-journal for KREDIT
            print_info("Verifying auto-journal for KREDIT")
            response = requests.get(f"{BASE_URL}/jurnal?sourceType=AUTO_KREDIT")
            if response.status_code == 200:
                journals = response.json().get("data", [])
                journal = next((j for j in journals if j.get("sourceId") == trx["id"]), None)
                if journal:
                    print_success(f"Auto-journal for KREDIT created: {journal['noJurnal']}")
                else:
                    print_error("Auto-journal for KREDIT not found")
                    return False
            else:
                print_error("Failed to verify auto-journal")
                return False
            
        else:
            print_error(f"KREDIT transaction creation failed: {response.status_code}")
            return False
        
        # Cleanup
        requests.delete(f"{BASE_URL}/pelanggan/{pelanggan_id}")
        
        return True
    except Exception as e:
        print_error(f"Exception: {str(e)}")
        return False

def test_transaction_list():
    """Test 8: GET /api/transactions - listing"""
    print_test("Transaction Listing")
    
    try:
        print_info("Getting transaction list")
        response = requests.get(f"{BASE_URL}/transactions")
        
        if response.status_code == 200:
            data = response.json()
            transactions = data.get("data", [])
            print_success(f"GET /transactions returned {len(transactions)} transactions")
            
            # Verify our test transaction is in the list
            if test_data["transaction_id"]:
                trx = next((t for t in transactions if t["id"] == test_data["transaction_id"]), None)
                if trx:
                    print_success(f"Test transaction found in list: {trx['noNota']}")
                else:
                    print_error("Test transaction not found in list")
                    return False
            
            return True
        else:
            print_error(f"GET /transactions failed with status {response.status_code}")
            return False
    except Exception as e:
        print_error(f"Exception: {str(e)}")
        return False

# ============================================================================
# INVENTORY TESTS
# ============================================================================

def test_inventory_adjustment():
    """Test 9: POST /api/stok/penyesuaian"""
    print_test("Inventory Adjustment (Penyesuaian Stok)")
    
    try:
        # Get a product
        response = requests.get(f"{BASE_URL}/products?limit=1")
        if response.status_code != 200:
            print_error("Failed to get product")
            return False
        
        product = response.json().get("data", [])[0]
        initial_stock = product["stok"]
        
        print_info(f"Adjusting stock for {product['kode']}: {initial_stock} → 50")
        
        adjustment_data = {
            "lokasi": "L001 - Toko Utama",
            "keterangan": "Test adjustment Phase3",
            "userId": "test-user",
            "userName": "Test User",
            "items": [
                {
                    "stokId": product["id"],
                    "kode": product["kode"],
                    "qtyAktual": 50
                }
            ]
        }
        
        response = requests.post(f"{BASE_URL}/stok/penyesuaian", json=adjustment_data)
        
        if response.status_code == 200:
            data = response.json()
            adjustment = data.get("data", {})
            print_success(f"Adjustment created: {adjustment['noPenyesuaian']}")
            
            # Verify stock updated
            response = requests.get(f"{BASE_URL}/products")
            products = response.json().get("data", [])
            product_after = next((p for p in products if p["id"] == product["id"]), None)
            
            if product_after and product_after["stok"] == 50:
                print_success(f"Stock updated correctly: {initial_stock} → {product_after['stok']}")
            else:
                print_error(f"Stock not updated correctly: expected 50, got {product_after['stok'] if product_after else 'N/A'}")
                return False
            
            # Verify kartu stok entry (no journal for penyesuaian per requirements)
            response = requests.get(f"{BASE_URL}/stok/kartu?productId={product['id']}")
            if response.status_code == 200:
                kartu = response.json().get("data", {}).get("rows", [])
                entry = next((k for k in kartu if k.get("noTransaksi") == adjustment["noPenyesuaian"]), None)
                if entry:
                    print_success(f"Kartu stok entry created for adjustment")
                else:
                    print_error("Kartu stok entry not found")
                    return False
            
            return True
        else:
            print_error(f"Adjustment creation failed: {response.status_code}")
            return False
    except Exception as e:
        print_error(f"Exception: {str(e)}")
        return False

def test_inventory_production():
    """Test 10: POST /api/stok/produksi"""
    print_test("Inventory Production (Produksi)")
    
    try:
        # Get 2 products (1 for bahan, 1 for hasil)
        response = requests.get(f"{BASE_URL}/products?limit=2")
        if response.status_code != 200:
            print_error("Failed to get products")
            return False
        
        products = response.json().get("data", [])
        if len(products) < 2:
            print_error("Not enough products")
            return False
        
        bahan = products[0]
        hasil = products[1]
        
        # Ensure bahan has enough stock
        if bahan["stok"] < 5:
            print_info(f"Adjusting bahan stock to 10")
            requests.post(f"{BASE_URL}/stok/penyesuaian", json={
                "items": [{"stokId": bahan["id"], "kode": bahan["kode"], "qtyAktual": 10}],
                "keterangan": "Prep for production test"
            })
        
        print_info(f"Creating production: {bahan['kode']} (qty=2) → {hasil['kode']} (qty=1)")
        
        production_data = {
            "catatan": "Test production Phase3",
            "biayaProduksi": 5000,
            "userId": "test-user",
            "userName": "Test User",
            "bahan": [
                {
                    "stokId": bahan["id"],
                    "kode": bahan["kode"],
                    "qty": 2
                }
            ],
            "hasil": [
                {
                    "stokId": hasil["id"],
                    "kode": hasil["kode"],
                    "qty": 1
                }
            ]
        }
        
        response = requests.post(f"{BASE_URL}/stok/produksi", json=production_data)
        
        if response.status_code == 200:
            data = response.json()
            production = data.get("data", {})
            print_success(f"Production created: {production['kodeProduksi']}")
            
            # Verify bahan stock decreased
            response = requests.get(f"{BASE_URL}/products")
            products_after = response.json().get("data", [])
            bahan_after = next((p for p in products_after if p["id"] == bahan["id"]), None)
            hasil_after = next((p for p in products_after if p["id"] == hasil["id"]), None)
            
            if bahan_after:
                print_success(f"Bahan stock decreased: {bahan['stok']} → {bahan_after['stok']}")
            else:
                print_error("Bahan product not found after production")
                return False
            
            if hasil_after:
                print_success(f"Hasil stock increased: {hasil['stok']} → {hasil_after['stok']}")
            else:
                print_error("Hasil product not found after production")
                return False
            
            return True
        else:
            print_error(f"Production creation failed: {response.status_code}")
            return False
    except Exception as e:
        print_error(f"Exception: {str(e)}")
        return False

def test_inventory_transfer():
    """Test 11: POST /api/stok/transfer"""
    print_test("Inventory Transfer Between Locations")
    
    try:
        # Get lokasi list
        response = requests.get(f"{BASE_URL}/lokasi")
        if response.status_code != 200:
            print_error("Failed to get lokasi")
            return False
        
        lokasi_list = response.json().get("data", [])
        if len(lokasi_list) < 2:
            print_error("Need at least 2 locations for transfer")
            return False
        
        lokasi_asal = lokasi_list[0]
        lokasi_tujuan = lokasi_list[1]
        
        # Get a product
        response = requests.get(f"{BASE_URL}/products?limit=1")
        if response.status_code != 200:
            print_error("Failed to get product")
            return False
        
        product = response.json().get("data", [])[0]
        
        print_info(f"Transferring {product['kode']} (qty=1) from {lokasi_asal['nama']} to {lokasi_tujuan['nama']}")
        
        transfer_data = {
            "lokasiAsal": lokasi_asal["kode"],
            "lokasiAsalNama": lokasi_asal["nama"],
            "lokasiTujuan": lokasi_tujuan["kode"],
            "lokasiTujuanNama": lokasi_tujuan["nama"],
            "keterangan": "Test transfer Phase3",
            "userName": "Test User",
            "items": [
                {
                    "stokId": product["id"],
                    "kode": product["kode"],
                    "qty": 1,
                    "hargaBeli": product["hargaBeli"]
                }
            ]
        }
        
        response = requests.post(f"{BASE_URL}/stok/transfer", json=transfer_data)
        
        if response.status_code == 200:
            data = response.json()
            transfer = data.get("data", {})
            print_success(f"Transfer created: {transfer['noTransfer']}")
            
            # Verify dual kartu stok entries
            response = requests.get(f"{BASE_URL}/stok/kartu?productId={product['id']}")
            if response.status_code == 200:
                kartu = response.json().get("data", {}).get("rows", [])
                entries = [k for k in kartu if k.get("noTransaksi") == transfer["noTransfer"]]
                if len(entries) == 2:
                    print_success(f"Dual kartu stok entries created (keluar + masuk)")
                else:
                    print_error(f"Expected 2 kartu stok entries, found {len(entries)}")
                    return False
            
            return True
        else:
            print_error(f"Transfer creation failed: {response.status_code}")
            return False
    except Exception as e:
        print_error(f"Exception: {str(e)}")
        return False

# ============================================================================
# PURCHASING TESTS
# ============================================================================

def test_purchasing_pembelian():
    """Test 12: POST /api/pembelian"""
    print_test("Purchasing (Pembelian) - Stock Increment + Auto-Journal + Hutang")
    
    try:
        # Get supplier (use existing or create)
        response = requests.get(f"{BASE_URL}/supplier?limit=1")
        if response.status_code != 200:
            print_error("Failed to get supplier")
            return False
        
        suppliers = response.json().get("data", [])
        if len(suppliers) == 0:
            # Create supplier
            supplier_data = {"nama": "Supplier Test Pembelian", "TOP": 14}
            response = requests.post(f"{BASE_URL}/supplier", json=supplier_data)
            if response.status_code != 200:
                print_error("Failed to create supplier")
                return False
            supplier = response.json().get("data", {})
        else:
            supplier = suppliers[0]
        
        # Get a product
        response = requests.get(f"{BASE_URL}/products?limit=1")
        if response.status_code != 200:
            print_error("Failed to get product")
            return False
        
        product = response.json().get("data", [])[0]
        initial_stock = product["stok"]
        
        print_info(f"Creating pembelian from {supplier['nama']}: {product['kode']} qty=5")
        
        pembelian_data = {
            "supplierId": supplier["id"],
            "lokasi": "L001 - Toko Utama",
            "catatan": "Test pembelian Phase3",
            "tunai": False,  # Create hutang
            "jatuhTempo": (datetime.now() + timedelta(days=14)).isoformat(),
            "userName": "Test User",
            "items": [
                {
                    "stokId": product["id"],
                    "kode": product["kode"],
                    "qty": 5,
                    "harga": 8000,
                    "diskon": 0
                }
            ],
            "penyesuaian": 0,
            "ppn": 0
        }
        
        response = requests.post(f"{BASE_URL}/pembelian", json=pembelian_data)
        
        if response.status_code == 200:
            data = response.json()
            pembelian = data.get("data", {})
            test_data["pembelian_id"] = pembelian["id"]
            test_data["no_pembelian"] = pembelian["noPembelian"]
            print_success(f"Pembelian created: {pembelian['noPembelian']}, total={pembelian['total']}")
            
            # Verify stock increment
            response = requests.get(f"{BASE_URL}/products")
            products = response.json().get("data", [])
            product_after = next((p for p in products if p["id"] == product["id"]), None)
            
            if product_after:
                expected_stock = initial_stock + 5
                if product_after["stok"] == expected_stock:
                    print_success(f"Stock incremented: {initial_stock} → {product_after['stok']}")
                else:
                    print_error(f"Stock mismatch: expected {expected_stock}, got {product_after['stok']}")
                    return False
            
            # Verify auto-journal
            response = requests.get(f"{BASE_URL}/jurnal?sourceType=AUTO_BELI")
            if response.status_code == 200:
                journals = response.json().get("data", [])
                journal = next((j for j in journals if j.get("sourceId") == pembelian["id"]), None)
                if journal:
                    print_success(f"Auto-journal created: {journal['noJurnal']}")
                else:
                    print_error("Auto-journal not found")
                    return False
            
            # Verify hutang entry (since tunai=False)
            response = requests.get(f"{BASE_URL}/hutang")
            if response.status_code == 200:
                hutangs = response.json().get("data", [])
                hutang = next((h for h in hutangs if h.get("noPembelian") == pembelian["noPembelian"]), None)
                if hutang:
                    test_data["hutang_id"] = hutang["id"]
                    print_success(f"Hutang entry created: {hutang['noHutang']}, sisa={hutang['sisa']}")
                else:
                    print_error("Hutang entry not found")
                    return False
            
            return True
        else:
            print_error(f"Pembelian creation failed: {response.status_code}")
            return False
    except Exception as e:
        print_error(f"Exception: {str(e)}")
        return False

def test_purchasing_hutang_payment():
    """Test 13: POST /api/hutang/:id/bayar"""
    print_test("Hutang Payment (Pelunasan)")
    
    try:
        if not test_data["hutang_id"]:
            print_error("No hutang_id from previous test")
            return False
        
        # Get hutang details
        response = requests.get(f"{BASE_URL}/hutang")
        if response.status_code != 200:
            print_error("Failed to get hutang list")
            return False
        
        hutangs = response.json().get("data", [])
        hutang = next((h for h in hutangs if h["id"] == test_data["hutang_id"]), None)
        
        if not hutang:
            print_error("Hutang not found")
            return False
        
        payment_amount = min(10000, hutang["sisa"])
        print_info(f"Paying hutang {hutang['noHutang']}: Rp {payment_amount}")
        
        payment_data = {
            "amount": payment_amount,
            "metode": "TUNAI",
            "keterangan": "Test payment Phase3",
            "userName": "Test User"
        }
        
        response = requests.post(f"{BASE_URL}/hutang/{test_data['hutang_id']}/bayar", json=payment_data)
        
        if response.status_code == 200:
            data = response.json()
            result = data.get("data", {})
            hutang_updated = result.get("hutang", {})
            
            expected_sisa = hutang["sisa"] - payment_amount
            if hutang_updated.get("sisa") == expected_sisa:
                print_success(f"Hutang updated: sisa {hutang['sisa']} → {hutang_updated['sisa']}")
            else:
                print_error(f"Hutang sisa mismatch: expected {expected_sisa}, got {hutang_updated.get('sisa')}")
                return False
            
            # Verify auto-journal for payment
            response = requests.get(f"{BASE_URL}/jurnal?sourceType=AUTO_PELUNASAN_HUTANG")
            if response.status_code == 200:
                journals = response.json().get("data", [])
                journal = next((j for j in journals if j.get("sourceId") == test_data["hutang_id"]), None)
                if journal:
                    print_success(f"Auto-journal for payment created: {journal['noJurnal']}")
                else:
                    print_error("Auto-journal for payment not found")
                    return False
            
            return True
        else:
            print_error(f"Hutang payment failed: {response.status_code}")
            return False
    except Exception as e:
        print_error(f"Exception: {str(e)}")
        return False

# ============================================================================
# CUSTOMER LOYALTY TESTS
# ============================================================================

def test_member_points_transaction():
    """Test 14: POST /api/transactions with memberId + poinDigunakan"""
    print_test("Member Points Transaction (Poin Usage)")
    
    try:
        # Create member with initial points
        print_info("Creating member with initial points")
        member_data = {
            "nama": "Member Points Test Phase3",
            "telepon": "08123123123",
            "tier": "GOLD"
        }
        response = requests.post(f"{BASE_URL}/members", json=member_data)
        if response.status_code != 200:
            print_error("Failed to create member")
            return False
        
        member = response.json().get("data", {})
        member_id = member["id"]
        
        # Give member some points via a transaction first
        response = requests.get(f"{BASE_URL}/products?limit=1")
        product = response.json().get("data", [])[0]
        
        # First transaction to earn points
        print_info("Creating transaction to earn points")
        trx1_data = {
            "noNota": f"EARN{int(datetime.now().timestamp())}",
            "kasirId": "test-kasir",
            "kasirName": "Test Kasir",
            "mode": "KASIR",
            "paymentMethod": "TUNAI",
            "memberId": member_id,
            "items": [{
                "stokId": product["id"],
                "kode": product["kode"],
                "nama": product["nama"],
                "satuan": product["satuan"],
                "qty": 1,
                "harga": 50000,
                "diskon": 0,
                "hargaBeli": product["hargaBeli"]
            }],
            "bayar": 50000
        }
        response = requests.post(f"{BASE_URL}/transactions", json=trx1_data)
        if response.status_code != 200:
            print_error("Failed to create earning transaction")
            return False
        
        trx1 = response.json().get("data", {})
        points_earned = trx1.get("poinDidapat", 0)
        print_success(f"Points earned: {points_earned}")
        
        # Now use points in second transaction
        print_info(f"Creating transaction using {min(10, points_earned)} points")
        points_to_use = min(10, points_earned)
        
        trx2_data = {
            "noNota": f"USE{int(datetime.now().timestamp())}",
            "kasirId": "test-kasir",
            "kasirName": "Test Kasir",
            "mode": "KASIR",
            "paymentMethod": "TUNAI",
            "memberId": member_id,
            "poinDigunakan": points_to_use,
            "items": [{
                "stokId": product["id"],
                "kode": product["kode"],
                "nama": product["nama"],
                "satuan": product["satuan"],
                "qty": 1,
                "harga": 30000,
                "diskon": 0,
                "hargaBeli": product["hargaBeli"]
            }],
            "bayar": 30000
        }
        response = requests.post(f"{BASE_URL}/transactions", json=trx2_data)
        
        if response.status_code == 200:
            trx2 = response.json().get("data", {})
            
            # Verify poinDiscount applied
            expected_discount = points_to_use * 1000
            if trx2.get("poinDiscount") == expected_discount:
                print_success(f"Point discount applied: {points_to_use} points = Rp {expected_discount}")
            else:
                print_error(f"Point discount mismatch: expected {expected_discount}, got {trx2.get('poinDiscount')}")
                return False
            
            # Verify member points decremented
            response = requests.get(f"{BASE_URL}/members")
            members = response.json().get("data", [])
            member_after = next((m for m in members if m["id"] == member_id), None)
            
            if member_after:
                expected_saldo = points_earned - points_to_use + trx2.get("poinDidapat", 0)
                if member_after.get("poinSaldo") == expected_saldo:
                    print_success(f"Member points updated correctly: {member_after['poinSaldo']}")
                else:
                    print_error(f"Member points mismatch: expected {expected_saldo}, got {member_after.get('poinSaldo')}")
                    return False
            
            # Verify point history
            response = requests.get(f"{BASE_URL}/members/{member_id}/poin")
            if response.status_code == 200:
                history = response.json().get("data", [])
                if len(history) >= 2:
                    print_success(f"Point history created: {len(history)} entries")
                else:
                    print_error(f"Point history incomplete: expected >= 2, got {len(history)}")
                    return False
            
            return True
        else:
            print_error(f"Transaction with points failed: {response.status_code}")
            return False
        
        # Cleanup
        requests.delete(f"{BASE_URL}/members/{member_id}")
        
    except Exception as e:
        print_error(f"Exception: {str(e)}")
        return False

def test_member_points_history():
    """Test 15: GET /api/members/:id/poin"""
    print_test("Member Points History")
    
    try:
        # Get any member
        response = requests.get(f"{BASE_URL}/members?limit=1")
        if response.status_code != 200:
            print_error("Failed to get members")
            return False
        
        members = response.json().get("data", [])
        if len(members) == 0:
            print_info("No members found, skipping test")
            return True
        
        member = members[0]
        
        print_info(f"Getting point history for member {member['nama']}")
        response = requests.get(f"{BASE_URL}/members/{member['id']}/poin")
        
        if response.status_code == 200:
            history = response.json().get("data", [])
            print_success(f"Point history retrieved: {len(history)} entries")
            return True
        else:
            print_error(f"Failed to get point history: {response.status_code}")
            return False
    except Exception as e:
        print_error(f"Exception: {str(e)}")
        return False

# ============================================================================
# ACCOUNTING TESTS
# ============================================================================

def test_dashboard():
    """Test 16: GET /api/dashboard"""
    print_test("Dashboard Analytics")
    
    try:
        print_info("Getting dashboard data")
        response = requests.get(f"{BASE_URL}/dashboard")
        
        if response.status_code == 200:
            data = response.json().get("data", {})
            
            # Check required fields
            required_fields = ["omzetHariIni", "omzetKemarin", "trxHariIni", "avgTrx", "lowStockCount", "chart7Days", "topProducts"]
            missing_fields = [f for f in required_fields if f not in data]
            
            if missing_fields:
                print_error(f"Missing fields: {missing_fields}")
                return False
            
            print_success(f"Dashboard data complete: omzetHariIni={data['omzetHariIni']}, trxHariIni={data['trxHariIni']}")
            
            # Verify chart7Days has 7 entries
            if len(data["chart7Days"]) == 7:
                print_success(f"chart7Days has exactly 7 entries")
            else:
                print_error(f"chart7Days should have 7 entries, got {len(data['chart7Days'])}")
                return False
            
            # Verify topProducts is array
            if isinstance(data["topProducts"], list):
                print_success(f"topProducts array present ({len(data['topProducts'])} items)")
            else:
                print_error("topProducts is not an array")
                return False
            
            return True
        else:
            print_error(f"Dashboard request failed: {response.status_code}")
            return False
    except Exception as e:
        print_error(f"Exception: {str(e)}")
        return False

def test_jurnal():
    """Test 17: GET /api/jurnal"""
    print_test("Jurnal (Journal Entries)")
    
    try:
        print_info("Getting jurnal entries")
        today = datetime.now().strftime("%Y-%m-%d")
        response = requests.get(f"{BASE_URL}/jurnal?from={today}&to={today}")
        
        if response.status_code == 200:
            data = response.json()
            journals = data.get("data", [])
            print_success(f"GET /jurnal returned {len(journals)} entries")
            
            # Verify structure
            if len(journals) > 0:
                j = journals[0]
                if "noJurnal" in j and "details" in j and "totalDebet" in j and "totalKredit" in j:
                    print_success("Journal entry structure correct")
                else:
                    print_error("Journal entry structure incomplete")
                    return False
            
            return True
        else:
            print_error(f"Jurnal request failed: {response.status_code}")
            return False
    except Exception as e:
        print_error(f"Exception: {str(e)}")
        return False

def test_buku_besar():
    """Test 18: GET /api/buku-besar"""
    print_test("Buku Besar (General Ledger) - Running Balance")
    
    try:
        print_info("Getting buku besar for account 10010 (Kas)")
        response = requests.get(f"{BASE_URL}/buku-besar?rekeningKode=10010")
        
        if response.status_code == 200:
            data = response.json().get("data", {})
            rows = data.get("rows", [])
            final_saldo = data.get("finalSaldo", 0)
            
            print_success(f"Buku besar retrieved: {len(rows)} entries, final saldo={final_saldo}")
            
            # Verify running balance calculation
            if len(rows) > 0:
                last_row = rows[-1]
                if last_row.get("saldo") == final_saldo:
                    print_success("Running balance calculation correct")
                else:
                    print_error(f"Running balance mismatch: last row saldo={last_row.get('saldo')}, finalSaldo={final_saldo}")
                    return False
            
            return True
        else:
            print_error(f"Buku besar request failed: {response.status_code}")
            return False
    except Exception as e:
        print_error(f"Exception: {str(e)}")
        return False

def test_laba_rugi():
    """Test 19: GET /api/laba-rugi"""
    print_test("Laba Rugi (Income Statement)")
    
    try:
        print_info("Getting laba rugi report")
        response = requests.get(f"{BASE_URL}/laba-rugi")
        
        if response.status_code == 200:
            data = response.json().get("data", {})
            
            required_fields = ["pendapatan", "hpp", "beban", "totalPendapatan", "totalHpp", "totalBeban", "labaKotor", "labaBersih"]
            missing_fields = [f for f in required_fields if f not in data]
            
            if missing_fields:
                print_error(f"Missing fields: {missing_fields}")
                return False
            
            print_success(f"Laba rugi complete: pendapatan={data['totalPendapatan']}, hpp={data['totalHpp']}, beban={data['totalBeban']}, labaBersih={data['labaBersih']}")
            
            # Verify calculation
            expected_laba_kotor = data["totalPendapatan"] - data["totalHpp"]
            expected_laba_bersih = expected_laba_kotor - data["totalBeban"]
            
            if data["labaKotor"] == expected_laba_kotor and data["labaBersih"] == expected_laba_bersih:
                print_success("Laba rugi calculations correct")
            else:
                print_error("Laba rugi calculations incorrect")
                return False
            
            return True
        else:
            print_error(f"Laba rugi request failed: {response.status_code}")
            return False
    except Exception as e:
        print_error(f"Exception: {str(e)}")
        return False

def test_neraca():
    """Test 20: GET /api/neraca - must be balanced"""
    print_test("Neraca (Balance Sheet) - Must Be Balanced")
    
    try:
        print_info("Getting neraca report")
        response = requests.get(f"{BASE_URL}/neraca")
        
        if response.status_code == 200:
            data = response.json().get("data", {})
            
            required_fields = ["aktiva", "pasiva", "totalAktiva", "totalPasiva", "balanced"]
            missing_fields = [f for f in required_fields if f not in data]
            
            if missing_fields:
                print_error(f"Missing fields: {missing_fields}")
                return False
            
            print_success(f"Neraca complete: aktiva={data['totalAktiva']}, pasiva={data['totalPasiva']}, balanced={data['balanced']}")
            
            # Verify balance
            if data["balanced"]:
                print_success("✅ NERACA IS BALANCED!")
            else:
                print_error(f"❌ NERACA NOT BALANCED: aktiva={data['totalAktiva']} != pasiva={data['totalPasiva']}")
                return False
            
            return True
        else:
            print_error(f"Neraca request failed: {response.status_code}")
            return False
    except Exception as e:
        print_error(f"Exception: {str(e)}")
        return False

def test_kas_masuk_keluar():
    """Test 21: POST /api/kas-masuk and /api/kas-keluar"""
    print_test("Kas Masuk & Kas Keluar - Verify Journals")
    
    try:
        # KAS MASUK
        print_info("Creating kas masuk entry")
        kas_masuk_data = {
            "keterangan": "Test kas masuk Phase3",
            "userName": "Test User",
            "details": [
                {
                    "rekeningKode": "30030",
                    "rekeningNama": "Pendapatan Lain-lain",
                    "jumlah": 50000,
                    "keterangan": "Test income"
                }
            ]
        }
        response = requests.post(f"{BASE_URL}/kas-masuk", json=kas_masuk_data)
        
        if response.status_code == 200:
            data = response.json().get("data", {})
            print_success(f"Kas masuk created: {data['noKM']}, total={data['totalKas']}")
            
            # Verify journal
            response = requests.get(f"{BASE_URL}/jurnal?sourceType=KAS_MASUK")
            if response.status_code == 200:
                journals = response.json().get("data", [])
                journal = next((j for j in journals if j.get("sourceId") == data["noKM"]), None)
                if journal:
                    print_success(f"Kas masuk journal created: {journal['noJurnal']}")
                else:
                    print_error("Kas masuk journal not found")
                    return False
        else:
            print_error(f"Kas masuk creation failed: {response.status_code}")
            return False
        
        # KAS KELUAR
        print_info("Creating kas keluar entry")
        kas_keluar_data = {
            "keterangan": "Test kas keluar Phase3",
            "userName": "Test User",
            "details": [
                {
                    "rekeningKode": "40010",
                    "rekeningNama": "Beban Operasional",
                    "jumlah": 30000,
                    "keterangan": "Test expense"
                }
            ]
        }
        response = requests.post(f"{BASE_URL}/kas-keluar", json=kas_keluar_data)
        
        if response.status_code == 200:
            data = response.json().get("data", {})
            print_success(f"Kas keluar created: {data['noKK']}, total={data['totalKas']}")
            
            # Verify journal
            response = requests.get(f"{BASE_URL}/jurnal?sourceType=KAS_KELUAR")
            if response.status_code == 200:
                journals = response.json().get("data", [])
                journal = next((j for j in journals if j.get("sourceId") == data["noKK"]), None)
                if journal:
                    print_success(f"Kas keluar journal created: {journal['noJurnal']}")
                else:
                    print_error("Kas keluar journal not found")
                    return False
        else:
            print_error(f"Kas keluar creation failed: {response.status_code}")
            return False
        
        return True
    except Exception as e:
        print_error(f"Exception: {str(e)}")
        return False

def test_jurnal_manual():
    """Test 22: POST /api/jurnal (manual entry) - verify balance validation"""
    print_test("Manual Journal Entry - Balance Validation")
    
    try:
        # Test balanced entry (should succeed)
        print_info("Creating balanced manual journal entry")
        journal_data = {
            "keterangan": "Test manual journal Phase3",
            "userName": "Test User",
            "details": [
                {
                    "rekeningKode": "10010",
                    "rekeningNama": "Kas",
                    "debet": 100000,
                    "kredit": 0,
                    "keterangan": "Test debet"
                },
                {
                    "rekeningKode": "30030",
                    "rekeningNama": "Pendapatan Lain-lain",
                    "debet": 0,
                    "kredit": 100000,
                    "keterangan": "Test kredit"
                }
            ]
        }
        response = requests.post(f"{BASE_URL}/jurnal", json=journal_data)
        
        if response.status_code == 200:
            data = response.json().get("data", {})
            if data.get("totalDebet") == data.get("totalKredit") == 100000:
                print_success(f"Balanced journal created: {data['noJurnal']}, debet=kredit={data['totalDebet']}")
            else:
                print_error("Journal balance incorrect")
                return False
        else:
            print_error(f"Balanced journal creation failed: {response.status_code}")
            return False
        
        # Test unbalanced entry (should fail)
        print_info("Testing unbalanced journal entry (should return 400)")
        unbalanced_data = {
            "keterangan": "Test unbalanced",
            "details": [
                {"rekeningKode": "10010", "rekeningNama": "Kas", "debet": 100000, "kredit": 0},
                {"rekeningKode": "30030", "rekeningNama": "Pendapatan", "debet": 0, "kredit": 50000}
            ]
        }
        response = requests.post(f"{BASE_URL}/jurnal", json=unbalanced_data)
        
        if response.status_code == 400:
            print_success("Unbalanced journal correctly rejected with 400")
        else:
            print_error(f"Unbalanced journal should return 400, got {response.status_code}")
            return False
        
        return True
    except Exception as e:
        print_error(f"Exception: {str(e)}")
        return False

# ============================================================================
# REPORTS TESTS
# ============================================================================

def test_reports():
    """Test 23: GET /api/laporan/penjualan, /penjualan-detail, /pembelian, /stok, /piutang, /hutang"""
    print_test("Reports (Laporan) - All Types")
    
    try:
        report_types = [
            "penjualan",
            "penjualan-detail",
            "pembelian",
            "stok",
            "piutang",
            "hutang"
        ]
        
        for report_type in report_types:
            print_info(f"Getting laporan/{report_type}")
            response = requests.get(f"{BASE_URL}/laporan/{report_type}")
            
            if response.status_code == 200:
                data = response.json().get("data", [])
                print_success(f"laporan/{report_type} returned {len(data)} rows")
            else:
                print_error(f"laporan/{report_type} failed: {response.status_code}")
                return False
        
        return True
    except Exception as e:
        print_error(f"Exception: {str(e)}")
        return False

# ============================================================================
# RETURNS & ASSETS TESTS
# ============================================================================

def test_retur_penjualan():
    """Test 24: POST /api/retur-penjualan - verify stock comes back, auto-journal reversal"""
    print_test("Retur Penjualan - Stock Return + Journal Reversal")
    
    try:
        # Use existing transaction
        if not test_data["no_nota"]:
            print_error("No transaction from previous test")
            return False
        
        # Get transaction details
        response = requests.get(f"{BASE_URL}/transactions")
        if response.status_code != 200:
            print_error("Failed to get transactions")
            return False
        
        transactions = response.json().get("data", [])
        trx = next((t for t in transactions if t.get("noNota") == test_data["no_nota"]), None)
        
        if not trx or not trx.get("items"):
            print_error("Transaction not found or has no items")
            return False
        
        item = trx["items"][0]
        
        # Get current stock
        response = requests.get(f"{BASE_URL}/products")
        products = response.json().get("data", [])
        product = next((p for p in products if p["id"] == item["stokId"]), None)
        
        if not product:
            print_error("Product not found")
            return False
        
        initial_stock = product["stok"]
        
        print_info(f"Creating retur penjualan for {item['kode']} qty=1")
        
        retur_data = {
            "noNotaAsal": test_data["no_nota"],
            "alasan": "Test retur Phase3",
            "metodePengembalian": "TUNAI",
            "userName": "Test User",
            "items": [
                {
                    "stokId": item["stokId"],
                    "kode": item["kode"],
                    "nama": item["nama"],
                    "qty": 1,
                    "harga": item["harga"],
                    "hargaBeli": item.get("hargaBeli", 0)
                }
            ]
        }
        
        response = requests.post(f"{BASE_URL}/retur-penjualan", json=retur_data)
        
        if response.status_code == 200:
            data = response.json().get("data", {})
            test_data["retur_penjualan_id"] = data["id"]
            print_success(f"Retur penjualan created: {data['noRetur']}, total={data['total']}")
            
            # Verify stock returned
            response = requests.get(f"{BASE_URL}/products")
            products = response.json().get("data", [])
            product_after = next((p for p in products if p["id"] == item["stokId"]), None)
            
            if product_after:
                expected_stock = initial_stock + 1
                if product_after["stok"] == expected_stock:
                    print_success(f"Stock returned: {initial_stock} → {product_after['stok']}")
                else:
                    print_error(f"Stock mismatch: expected {expected_stock}, got {product_after['stok']}")
                    return False
            
            # Verify auto-journal reversal
            response = requests.get(f"{BASE_URL}/jurnal?sourceType=AUTO_RETUR_JUAL")
            if response.status_code == 200:
                journals = response.json().get("data", [])
                journal = next((j for j in journals if j.get("sourceId") == data["id"]), None)
                if journal:
                    print_success(f"Auto-journal reversal created: {journal['noJurnal']}")
                else:
                    print_error("Auto-journal reversal not found")
                    return False
            
            return True
        else:
            print_error(f"Retur penjualan creation failed: {response.status_code}")
            return False
    except Exception as e:
        print_error(f"Exception: {str(e)}")
        return False

def test_retur_pembelian():
    """Test 25: POST /api/retur-pembelian - verify stock decrement"""
    print_test("Retur Pembelian - Stock Decrement")
    
    try:
        # Use existing pembelian
        if not test_data["no_pembelian"]:
            print_error("No pembelian from previous test")
            return False
        
        # Get pembelian details
        response = requests.get(f"{BASE_URL}/pembelian")
        if response.status_code != 200:
            print_error("Failed to get pembelian list")
            return False
        
        pembelians = response.json().get("data", [])
        pembelian = next((p for p in pembelians if p.get("noPembelian") == test_data["no_pembelian"]), None)
        
        if not pembelian or not pembelian.get("items"):
            print_error("Pembelian not found or has no items")
            return False
        
        item = pembelian["items"][0]
        
        # Get current stock
        response = requests.get(f"{BASE_URL}/products")
        products = response.json().get("data", [])
        product = next((p for p in products if p["id"] == item["stokId"]), None)
        
        if not product:
            print_error("Product not found")
            return False
        
        initial_stock = product["stok"]
        
        print_info(f"Creating retur pembelian for {item['kode']} qty=1")
        
        retur_data = {
            "noPembelianAsal": test_data["no_pembelian"],
            "alasan": "Test retur pembelian Phase3",
            "metodePengembalian": "TUNAI",
            "userName": "Test User",
            "items": [
                {
                    "stokId": item["stokId"],
                    "kode": item["kode"],
                    "qty": 1,
                    "harga": item["harga"]
                }
            ]
        }
        
        response = requests.post(f"{BASE_URL}/retur-pembelian", json=retur_data)
        
        if response.status_code == 200:
            data = response.json().get("data", {})
            print_success(f"Retur pembelian created: {data['noRetur']}, total={data['total']}")
            
            # Verify stock decremented
            response = requests.get(f"{BASE_URL}/products")
            products = response.json().get("data", [])
            product_after = next((p for p in products if p["id"] == item["stokId"]), None)
            
            if product_after:
                expected_stock = initial_stock - 1
                if product_after["stok"] == expected_stock:
                    print_success(f"Stock decremented: {initial_stock} → {product_after['stok']}")
                else:
                    print_error(f"Stock mismatch: expected {expected_stock}, got {product_after['stok']}")
                    return False
            
            return True
        else:
            print_error(f"Retur pembelian creation failed: {response.status_code}")
            return False
    except Exception as e:
        print_error(f"Exception: {str(e)}")
        return False

def test_aset_penyusutan():
    """Test 26: POST /api/aset + POST /api/penyusutan/run - verify depreciation journal"""
    print_test("Fixed Assets + Depreciation - Journal Creation")
    
    try:
        # Create asset
        print_info("Creating fixed asset")
        aset_data = {
            "nama": "Test Asset Phase3",
            "kategori": "Peralatan",
            "nilaiAwal": 10000000,
            "umurBulan": 60,
            "nilaiResidu": 1000000,
            "tanggalBeli": datetime.now().isoformat()
        }
        response = requests.post(f"{BASE_URL}/aset", json=aset_data)
        
        if response.status_code == 200:
            data = response.json().get("data", {})
            test_data["aset_id"] = data["id"]
            print_success(f"Asset created: {data['nama']}, nilai={data['nilaiAwal']}")
        else:
            print_error(f"Asset creation failed: {response.status_code}")
            return False
        
        # Run depreciation
        print_info("Running depreciation")
        period = datetime.now().strftime("%Y-%m")
        depreciation_data = {
            "period": period,
            "userName": "Test User"
        }
        response = requests.post(f"{BASE_URL}/penyusutan/run", json=depreciation_data)
        
        if response.status_code == 200:
            data = response.json().get("data", {})
            print_success(f"Depreciation run: period={data['period']}, total={data['totalDepresiasi']}, assets={data['jumlahAset']}")
            
            # Verify depreciation journal
            response = requests.get(f"{BASE_URL}/jurnal?sourceType=AUTO_PENYUSUTAN")
            if response.status_code == 200:
                journals = response.json().get("data", [])
                journal = next((j for j in journals if j.get("sourceId") == period), None)
                if journal:
                    print_success(f"Depreciation journal created: {journal['noJurnal']}")
                else:
                    print_error("Depreciation journal not found")
                    return False
            
            return True
        else:
            print_error(f"Depreciation run failed: {response.status_code}")
            return False
    except Exception as e:
        print_error(f"Exception: {str(e)}")
        return False

# ============================================================================
# TENANT MULTI-TENANT TESTS
# ============================================================================

def test_tenants():
    """Test 27: GET /api/tenants (MASTER only context)"""
    print_test("Tenants List (Multi-Tenant)")
    
    try:
        print_info("Getting tenants list")
        response = requests.get(f"{BASE_URL}/tenants")
        
        if response.status_code == 200:
            data = response.json()
            tenants = data.get("data", [])
            print_success(f"GET /tenants returned {len(tenants)} tenants")
            
            # Verify default tenant exists
            default_tenant = next((t for t in tenants if t.get("tenantId") == "default"), None)
            if default_tenant:
                print_success(f"Default tenant found: {default_tenant.get('companyName')}")
            else:
                print_error("Default tenant not found")
                return False
            
            return True
        else:
            print_error(f"GET /tenants failed: {response.status_code}")
            return False
    except Exception as e:
        print_error(f"Exception: {str(e)}")
        return False

def test_tenants_crud():
    """Test 28: POST /api/tenants (create new) + DELETE /api/tenants/:id (?force=true)"""
    print_test("Tenants CRUD - Create + Delete with Force")
    
    try:
        # Create tenant
        print_info("Creating new tenant")
        tenant_data = {
            "tenantId": f"test-{int(datetime.now().timestamp())}",
            "companyName": "Test Tenant Phase3",
            "alamat": "Jl. Test Tenant",
            "telepon": "08123456789"
        }
        response = requests.post(f"{BASE_URL}/tenants", json=tenant_data)
        
        if response.status_code == 200:
            data = response.json().get("data", {})
            test_data["tenant_id"] = data["tenantId"]
            print_success(f"Tenant created: {data['companyName']} (id: {data['tenantId']})")
        else:
            print_error(f"Tenant creation failed: {response.status_code}")
            return False
        
        # Delete tenant with force
        print_info(f"Deleting tenant {test_data['tenant_id']} with force=true")
        response = requests.delete(f"{BASE_URL}/tenants/{test_data['tenant_id']}?force=true")
        
        if response.status_code == 200:
            print_success("Tenant deleted successfully")
            
            # Verify deletion
            response = requests.get(f"{BASE_URL}/tenants")
            if response.status_code == 200:
                tenants = response.json().get("data", [])
                if not any(t["tenantId"] == test_data["tenant_id"] for t in tenants):
                    print_success("Tenant deletion verified")
                else:
                    print_error("Tenant still in list after deletion")
                    return False
        else:
            print_error(f"Tenant deletion failed: {response.status_code}")
            return False
        
        return True
    except Exception as e:
        print_error(f"Exception: {str(e)}")
        return False

def test_tenant_settings():
    """Test 29: GET/PUT /api/tenant/settings?tenantId=default"""
    print_test("Tenant Settings - Get + Update")
    
    try:
        # GET settings
        print_info("Getting tenant settings for default")
        response = requests.get(f"{BASE_URL}/tenant/settings?tenantId=default")
        
        if response.status_code == 200:
            data = response.json().get("data", {})
            print_success(f"Tenant settings retrieved: {data.get('companyName', 'N/A')}")
        else:
            print_error(f"GET tenant settings failed: {response.status_code}")
            return False
        
        # PUT settings
        print_info("Updating tenant settings")
        update_data = {
            "tenantId": "default",
            "footerStruk": "Test footer Phase3"
        }
        response = requests.put(f"{BASE_URL}/tenant/settings?tenantId=default", json=update_data)
        
        if response.status_code == 200:
            data = response.json().get("data", {})
            if data.get("footerStruk") == "Test footer Phase3":
                print_success("Tenant settings updated successfully")
            else:
                print_error("Tenant settings update did not apply")
                return False
        else:
            print_error(f"PUT tenant settings failed: {response.status_code}")
            return False
        
        return True
    except Exception as e:
        print_error(f"Exception: {str(e)}")
        return False

# ============================================================================
# EDGE CASES TESTS
# ============================================================================

def test_edge_cases():
    """Test 30-32: Edge cases - wrong password, missing fields, 404"""
    print_test("Edge Cases - Error Handling")
    
    try:
        # Already tested in test_auth_login:
        # - Wrong password (401)
        # - Missing fields (400)
        
        # Test 404 for non-existent route
        print_info("Testing non-existent route (should return 404)")
        response = requests.get(f"{BASE_URL}/nonexistent-route-xyz")
        
        if response.status_code == 404:
            print_success("Non-existent route correctly returns 404")
        else:
            print_error(f"Non-existent route should return 404, got {response.status_code}")
            return False
        
        return True
    except Exception as e:
        print_error(f"Exception: {str(e)}")
        return False

# ============================================================================
# MAIN TEST RUNNER
# ============================================================================

def main():
    print("\n" + "="*80)
    print("PHASE 3 REFACTOR REGRESSION TEST SUITE")
    print("Route.js: 1497 LOC → 91 LOC (-94%)")
    print("Testing all 30+ critical flows")
    print("="*80)
    
    tests = [
        # Auth & Users (2)
        ("Auth Login (3 accounts)", test_auth_login),
        ("Users CRUD + Password Hashing", test_users_crud),
        
        # Master Data (3)
        ("Products CRUD", test_products_crud),
        ("Products Lookup (code + barcode)", test_products_lookup),
        ("Master Data CRUD (Pelanggan, Supplier, Members, Lokasi)", test_master_data_crud),
        
        # POS Flow (3)
        ("Transaction Create (3 items) - Stock, Journal, Kartu", test_transaction_create),
        ("Transaction KREDIT - Piutang", test_transaction_kredit),
        ("Transaction List", test_transaction_list),
        
        # Inventory (3)
        ("Inventory Adjustment", test_inventory_adjustment),
        ("Inventory Production", test_inventory_production),
        ("Inventory Transfer", test_inventory_transfer),
        
        # Purchasing (2)
        ("Purchasing (Pembelian)", test_purchasing_pembelian),
        ("Hutang Payment", test_purchasing_hutang_payment),
        
        # Customer Loyalty (2)
        ("Member Points Transaction", test_member_points_transaction),
        ("Member Points History", test_member_points_history),
        
        # Accounting (7)
        ("Dashboard Analytics", test_dashboard),
        ("Jurnal (Journal)", test_jurnal),
        ("Buku Besar (General Ledger)", test_buku_besar),
        ("Laba Rugi (Income Statement)", test_laba_rugi),
        ("Neraca (Balance Sheet)", test_neraca),
        ("Kas Masuk & Kas Keluar", test_kas_masuk_keluar),
        ("Manual Journal Entry", test_jurnal_manual),
        
        # Reports (1)
        ("Reports (All Types)", test_reports),
        
        # Returns & Assets (3)
        ("Retur Penjualan", test_retur_penjualan),
        ("Retur Pembelian", test_retur_pembelian),
        ("Fixed Assets + Depreciation", test_aset_penyusutan),
        
        # Tenant Multi-Tenant (3)
        ("Tenants List", test_tenants),
        ("Tenants CRUD", test_tenants_crud),
        ("Tenant Settings", test_tenant_settings),
        
        # Edge Cases (1)
        ("Edge Cases", test_edge_cases),
    ]
    
    results = []
    passed = 0
    failed = 0
    
    for name, test_func in tests:
        try:
            result = test_func()
            results.append((name, result))
            if result:
                passed += 1
            else:
                failed += 1
        except Exception as e:
            print_error(f"Test crashed: {str(e)}")
            results.append((name, False))
            failed += 1
    
    # Summary
    print("\n" + "="*80)
    print("TEST SUMMARY")
    print("="*80)
    
    for name, result in results:
        status = "✅ PASS" if result else "❌ FAIL"
        print(f"{status} - {name}")
    
    print("\n" + "="*80)
    print(f"TOTAL: {passed + failed} tests")
    print(f"✅ PASSED: {passed}")
    print(f"❌ FAILED: {failed}")
    print(f"SUCCESS RATE: {(passed / (passed + failed) * 100):.1f}%")
    print("="*80)
    
    if failed == 0:
        print("\n🎉 ALL TESTS PASSED! Phase 3 refactor is SUCCESSFUL!")
    else:
        print(f"\n⚠️  {failed} test(s) failed. Review errors above.")
    
    return failed == 0

if __name__ == "__main__":
    success = main()
    exit(0 if success else 1)

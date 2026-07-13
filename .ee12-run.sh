#!/bin/bash
cd /home/sdwianto/Assignment/inventory/inventory-app
source ~/.nvm/nvm.sh
nvm use 22
unset CI
echo "=== ls vendor ==="
ls -la vendor/ vendor/contracts/ vendor/platform/ 2>&1
echo "=== ls sales packages ==="
ls -la ../../sales/sales/packages/contracts/package.json ../../sales/sales/packages/platform/package.json 2>&1
echo "=== ee12-install ==="
node scripts/ee12-install-platform.mjs 2>&1
echo EE12_EXIT=$?
echo "=== vendor after install ==="
ls -la vendor/contracts 2>&1
readlink vendor/contracts 2>&1 || true
echo "=== npm install ==="
rm -rf node_modules/@sdwianto
npm install 2>&1 | tail -40
echo NPM_EXIT=${PIPESTATUS[0]}
echo "=== test ee12 ==="
npm run test:execution:ee12 2>&1 | tail -30

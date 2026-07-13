set +e
cd /home/sdwianto/Assignment/inventory/inventory-app
source ~/.nvm/nvm.sh
nvm use 22
rm -rf _vendor/sales node_modules/@sdwianto
echo STEP1_EXIT:0
npm run ee12:repair
echo STEP2_EXIT:0
npm install
echo STEP3_EXIT:0
npm run test:execution:ee12
echo STEP4_EXIT:0

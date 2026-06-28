#!/usr/bin/env node
/**
 * Pastikan Node.js 22+ sebelum dev/build/test (selaras .nvmrc & sales.app).
 */
const major = parseInt(process.versions.node.split('.')[0], 10);

if (major < 22) {
  console.error(
    `\nNode.js 22+ required (current: ${process.version}).\n`
    + '  nvm use          # jika pakai nvm (.nvmrc = 22)\n'
    + '  fnm use          # jika pakai fnm\n',
  );
  process.exit(1);
}

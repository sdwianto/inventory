const nextConfig = {
  output: 'standalone',
  transpilePackages: ['@sdwianto/contracts', '@sdwianto/events', '@sdwianto/metrics', '@sdwianto/platform'],
  images: {
    unoptimized: true,
    remotePatterns: [
      { protocol: 'https', hostname: 'avatars.githubusercontent.com', pathname: '/**' },
    ],
  },
  serverExternalPackages: ['mongodb'],
  // Next 16 Turbopack does not honor webpack resolve.extensionAlias for
  // TypeScript ESM (import '.../foo.js' → foo.ts). Production build uses --webpack
  // (see package.json). Keep turbopack key so `next dev` stays valid.
  turbopack: {},
  webpack(config, { dev }) {
    // @sdwianto/* packages ship TS sources with NodeNext ".js" import specifiers.
    config.resolve = config.resolve ?? {};
    config.resolve.extensionAlias = {
      ...(config.resolve.extensionAlias ?? {}),
      '.js': ['.ts', '.tsx', '.js'],
      '.mjs': ['.mts', '.mjs'],
    };
    if (dev) {
      // Used when running `npm run dev:webpack` (--webpack)
      config.watchOptions = {
        poll: 2000,
        aggregateTimeout: 300,
        ignored: ['**/node_modules'],
      };
    }
    return config;
  },
  onDemandEntries: {
    maxInactiveAge: 10000,
    pagesBufferLength: 2,
  },
  async headers() {
    const isProd = process.env.NODE_ENV === 'production';
    const corsOrigins = (process.env.CORS_ORIGINS || '').trim();
    const allowFraming = process.env.ALLOW_FRAMING === '1';
    const frameAncestors = allowFraming || !isProd ? '*' : "'self'";

    const headers = [
      { key: 'X-Content-Type-Options', value: 'nosniff' },
      { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
      { key: 'Content-Security-Policy', value: `frame-ancestors ${frameAncestors};` },
      { key: 'Access-Control-Allow-Methods', value: 'GET, POST, PUT, DELETE, OPTIONS' },
      { key: 'Access-Control-Allow-Headers', value: 'Content-Type, Authorization, x-api-key' },
    ];

    if (!allowFraming && isProd) {
      headers.push({ key: 'X-Frame-Options', value: 'SAMEORIGIN' });
    } else {
      headers.push({ key: 'X-Frame-Options', value: 'ALLOWALL' });
    }

    if (isProd && process.env.ENABLE_HSTS !== '0') {
      headers.push({
        key: 'Strict-Transport-Security',
        value: 'max-age=31536000; includeSubDomains',
      });
    }

    // CORS: di production hanya set jika CORS_ORIGINS dikonfigurasi (fail closed).
    const allowOrigin = corsOrigins ? corsOrigins.split(',')[0].trim() : isProd ? '' : '*';
    if (allowOrigin) {
      headers.push({ key: 'Access-Control-Allow-Origin', value: allowOrigin });
    }

    return [{ source: '/(.*)', headers }];
  },
};

module.exports = nextConfig;

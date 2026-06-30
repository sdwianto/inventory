const nextConfig = {
  output: 'standalone',
  images: {
    unoptimized: true,
    remotePatterns: [
      { protocol: 'https', hostname: 'avatars.githubusercontent.com', pathname: '/**' },
    ],
  },
  serverExternalPackages: ['mongodb'],
  // Next.js 16 dev uses Turbopack by default; empty config acknowledges custom webpack is build-only
  turbopack: {},
  webpack(config, { dev }) {
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

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { SESSION_COOKIE, verifySessionToken } from '@/lib/api/session';
import { buildEdgeSessionHeaders } from '@/lib/api/edge-session';
import { isPublicRoute } from '@/lib/api/require-auth';

function injectEdgeSession(request: NextRequest, payload: ReturnType<typeof verifySessionToken>) {
  if (!payload?.sub) return NextResponse.next();
  const headers = new Headers(request.headers);
  for (const [key, value] of Object.entries(buildEdgeSessionHeaders(payload))) {
    headers.set(key, value);
  }
  return NextResponse.next({ request: { headers } });
}

export default function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const method = request.method;

  if (pathname.startsWith('/_next')) return NextResponse.next();
  if (/\.[a-zA-Z0-9]+$/.test(pathname)) return NextResponse.next();

  if (pathname.startsWith('/api')) {
    const route = pathname.replace(/^\/api/, '') || '/';
    if (isPublicRoute(method, route)) return NextResponse.next();
    const session = request.cookies.get(SESSION_COOKIE);
    return injectEdgeSession(request, verifySessionToken(session?.value));
  }

  if (pathname === '/') return NextResponse.next();

  const session = request.cookies.get(SESSION_COOKIE);
  const payload = verifySessionToken(session?.value);
  if (!payload?.sub) {
    const login = new URL('/', request.url);
    login.searchParams.set('next', pathname);
    return NextResponse.redirect(login);
  }

  return NextResponse.next();
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};

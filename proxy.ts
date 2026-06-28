import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { SESSION_COOKIE, verifySessionToken } from '@/lib/api/session';

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (pathname === '/') return NextResponse.next();
  if (pathname.startsWith('/api')) return NextResponse.next();
  if (pathname.startsWith('/_next')) return NextResponse.next();
  if (/\.[a-zA-Z0-9]+$/.test(pathname)) return NextResponse.next();

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

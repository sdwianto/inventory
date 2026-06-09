// Server-side guard: halaman app (bukan API) wajib punya session cookie.

import { NextResponse } from 'next/server';

const SESSION_COOKIE = 'inventory_session';

export function proxy(request) {
  const { pathname } = request.nextUrl;

  if (pathname === '/') return NextResponse.next();
  if (pathname.startsWith('/api')) return NextResponse.next();
  if (pathname.startsWith('/_next')) return NextResponse.next();
  if (/\.[a-zA-Z0-9]+$/.test(pathname)) return NextResponse.next();

  const session = request.cookies.get(SESSION_COOKIE);
  if (!session?.value) {
    const login = new URL('/', request.url);
    login.searchParams.set('next', pathname);
    return NextResponse.redirect(login);
  }

  return NextResponse.next();
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};

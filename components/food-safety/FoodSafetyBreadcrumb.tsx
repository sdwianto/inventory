'use client';

import Link from 'next/link';

type Crumb = { href?: string; label: string };

/** Breadcrumb ringan untuk jalur Keamanan Pangan (Gelombang 0). */
export default function FoodSafetyBreadcrumb({
  items,
}: {
  items: Crumb[];
}) {
  const all: Crumb[] = [{ href: '/kitchen-assurance', label: 'Keamanan Pangan' }, ...items];
  return (
    <nav className="text-xs text-muted-foreground" aria-label="Breadcrumb">
      {all.map((c, i) => {
        const last = i === all.length - 1;
        return (
          <span key={`${c.label}-${i}`}>
            {i > 0 ? <span className="mx-1">/</span> : null}
            {c.href && !last ? (
              <Link href={c.href} className="text-blue-700 hover:underline">
                {c.label}
              </Link>
            ) : (
              <span className={last ? 'text-foreground' : undefined}>{c.label}</span>
            )}
          </span>
        );
      })}
    </nav>
  );
}

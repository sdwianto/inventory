'use client';

import { useEffect, useId, useState } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { cn } from '@/lib/utils';

interface ImageZoomProps {
  src: string;
  alt: string;
  className?: string;
  /** Ukuran thumbnail wrapper (default h-24 w-24). */
  thumbClassName?: string;
}

/** Thumbnail klik → preview full-screen (pola portal penarukan / organoleptik). */
export function ImageZoom({
  src,
  alt,
  className,
  thumbClassName,
}: ImageZoomProps) {
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const titleId = useId();

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    if (!open) return;

    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }

    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    window.addEventListener('keydown', onKeyDown);
    return () => {
      document.body.style.overflow = prevOverflow;
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={`Perbesar ${alt}`}
        title="Klik untuk memperbesar"
        className={cn(
          'group relative overflow-hidden rounded-xl border bg-slate-100 outline-none transition',
          'hover:z-10 hover:shadow-lg focus-visible:ring-2 focus-visible:ring-orange-400',
          thumbClassName ?? 'h-24 w-24',
        )}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={src}
          alt={alt}
          className={cn(
            'h-full w-full object-cover transition duration-200 ease-out',
            'group-hover:scale-125',
            className,
          )}
        />
        <span className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/55 to-transparent px-1.5 py-1 text-[10px] font-medium text-white opacity-0 transition group-hover:opacity-100">
          Perbesar
        </span>
      </button>

      {open && mounted
        ? createPortal(
            <div
              role="dialog"
              aria-modal="true"
              aria-labelledby={titleId}
              className="fixed inset-0 z-[200] flex items-center justify-center bg-black/75 p-4 backdrop-blur-sm"
              onClick={() => setOpen(false)}
            >
              <p id={titleId} className="sr-only">
                {alt}
              </p>
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="absolute right-4 top-4 rounded-full bg-black/60 p-2 text-white hover:bg-black/80"
                aria-label="Tutup preview gambar"
              >
                <X className="h-5 w-5" />
              </button>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={src}
                alt={alt}
                onClick={(e) => e.stopPropagation()}
                className="max-h-[90vh] max-w-[min(96vw,56rem)] rounded-lg object-contain shadow-2xl"
              />
            </div>,
            document.body,
          )
        : null}
    </>
  );
}

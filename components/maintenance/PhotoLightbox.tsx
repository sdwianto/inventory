'use client';

import { useCallback, useEffect, useState } from 'react';
import { ChevronLeft, ChevronRight, X } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface PhotoLightboxProps {
  photos: string[];
  /** Ukuran thumbnail persegi, default w-24 h-24 */
  thumbSize?: 'sm' | 'md';
  label?: string;
  className?: string;
}

const THUMB_SIZE = {
  sm: 'w-20 h-20',
  md: 'w-24 h-24',
} as const;

export default function PhotoLightbox({
  photos,
  thumbSize = 'md',
  label,
  className,
}: PhotoLightboxProps) {
  const [index, setIndex] = useState<number | null>(null);

  const close = useCallback(() => setIndex(null), []);
  const prev = useCallback(() => {
    setIndex((i) => (i == null ? null : (i - 1 + photos.length) % photos.length));
  }, [photos.length]);
  const next = useCallback(() => {
    setIndex((i) => (i == null ? null : (i + 1) % photos.length));
  }, [photos.length]);

  useEffect(() => {
    if (index == null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
      if (e.key === 'ArrowLeft') prev();
      if (e.key === 'ArrowRight') next();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [index, close, prev, next]);

  if (!photos.length) return null;

  const thumbClass = THUMB_SIZE[thumbSize];
  const current = index != null ? photos[index] : null;

  return (
    <>
      <div className={className}>
        {label ? (
          <p className="text-xs font-medium uppercase tracking-wide text-slate-500 mb-2">{label}</p>
        ) : null}
        <div className="flex flex-wrap gap-2">
          {photos.map((src, i) => (
            <button
              key={`thumb-${i}-${src.slice(0, 32)}`}
              type="button"
              className={`${thumbClass} rounded-lg border overflow-hidden bg-slate-50 hover:ring-2 hover:ring-orange-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-400 cursor-zoom-in`}
              onClick={(e) => {
                e.stopPropagation();
                setIndex(i);
              }}
              aria-label={`Perbesar foto ${i + 1}`}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={src} alt={`Foto ${i + 1}`} className="w-full h-full object-cover" />
            </button>
          ))}
        </div>
      </div>

      {current != null && index != null && (
        <div
          className="fixed inset-0 z-[100] flex flex-col bg-black/90"
          role="dialog"
          aria-modal="true"
          aria-label={`Foto ${index + 1} dari ${photos.length}`}
        >
          <div className="flex items-center justify-between gap-2 px-3 py-2 text-white shrink-0">
            <span className="text-sm tabular-nums">
              {index + 1} / {photos.length}
            </span>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="text-white hover:bg-white/20 hover:text-white shrink-0"
              onClick={close}
              aria-label="Tutup"
            >
              <X className="w-5 h-5" />
            </Button>
          </div>

          <div
            className="relative flex-1 flex items-center justify-center min-h-0 px-2 pb-[max(0.75rem,env(safe-area-inset-bottom))]"
            onClick={close}
          >
            {photos.length > 1 && (
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="absolute left-2 top-1/2 -translate-y-1/2 text-white hover:bg-white/20 hover:text-white z-10"
                onClick={(e) => { e.stopPropagation(); prev(); }}
                aria-label="Foto sebelumnya"
              >
                <ChevronLeft className="w-8 h-8" />
              </Button>
            )}

            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={current}
              alt={`Foto ${index + 1}`}
              className="max-w-full max-h-full object-contain select-none"
              onClick={(e) => e.stopPropagation()}
            />

            {photos.length > 1 && (
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="absolute right-2 top-1/2 -translate-y-1/2 text-white hover:bg-white/20 hover:text-white z-10"
                onClick={(e) => { e.stopPropagation(); next(); }}
                aria-label="Foto berikutnya"
              >
                <ChevronRight className="w-8 h-8" />
              </Button>
            )}
          </div>
        </div>
      )}
    </>
  );
}

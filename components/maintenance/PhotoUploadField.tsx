'use client';

import { useRef } from 'react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { toast } from 'sonner';
import { compressImageFile } from '@/lib/image-upload-client';
import { ImageIcon, Upload, X } from 'lucide-react';

interface PhotoUploadFieldProps {
  label?: string;
  hint?: string;
  photos: string[];
  onChange: (photos: string[]) => void;
  maxPhotos?: number;
  disabled?: boolean;
}

export default function PhotoUploadField({
  label = 'Foto',
  hint,
  photos,
  onChange,
  maxPhotos = 5,
  disabled = false,
}: PhotoUploadFieldProps) {
  const fileRef = useRef<HTMLInputElement | null>(null);
  const canAdd = photos.length < maxPhotos;

  const handleFiles = async (files: FileList | null) => {
    if (!files?.length || disabled) return;
    const remaining = maxPhotos - photos.length;
    const picked = Array.from(files).slice(0, remaining);
    if (files.length > remaining) {
      toast.message(`Hanya ${remaining} slot foto tersisa`);
    }
    const next = [...photos];
    for (const file of picked) {
      try {
        const dataUrl = await compressImageFile(file);
        next.push(dataUrl);
      } catch (e) {
        toast.error(e instanceof Error ? e.message : 'Gagal memuat gambar');
      }
    }
    onChange(next);
    if (fileRef.current) fileRef.current.value = '';
  };

  const removeAt = (index: number) => {
    onChange(photos.filter((_, i) => i !== index));
  };

  return (
    <div className="space-y-2">
      <Label>{label}</Label>
      {hint && <p className="text-xs text-slate-500">{hint}</p>}
      <div className="flex flex-wrap gap-2">
        {photos.map((src, i) => (
          <div key={`${i}-${src.slice(0, 32)}`} className="relative w-24 h-24 rounded-lg border bg-slate-50 overflow-hidden">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={src} alt={`${label} ${i + 1}`} className="w-full h-full object-cover" />
            {!disabled && (
              <button
                type="button"
                className="absolute top-1 right-1 rounded-full bg-black/60 p-0.5 text-white hover:bg-black/80"
                onClick={() => removeAt(i)}
                aria-label="Hapus foto"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
        ))}
        {canAdd && !disabled && (
          <button
            type="button"
            className="w-24 h-24 rounded-lg border border-dashed border-slate-300 flex flex-col items-center justify-center gap-1 text-slate-500 hover:bg-slate-50 hover:border-orange-400 hover:text-orange-600 transition-colors"
            onClick={() => fileRef.current?.click()}
          >
            {photos.length ? <Upload className="w-5 h-5" /> : <ImageIcon className="w-5 h-5" />}
            <span className="text-[10px] px-1 text-center leading-tight">
              {photos.length ? 'Tambah' : 'Upload'}
            </span>
          </button>
        )}
      </div>
      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        multiple={maxPhotos > 1}
        className="hidden"
        disabled={disabled}
        onChange={(e) => void handleFiles(e.target.files)}
      />
      {photos.length > 0 && !disabled && (
        <Button type="button" variant="ghost" size="sm" className="h-8 px-2 text-slate-600" onClick={() => onChange([])}>
          Hapus semua foto
        </Button>
      )}
    </div>
  );
}

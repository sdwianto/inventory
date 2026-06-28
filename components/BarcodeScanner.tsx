'use client';

import { useEffect, useRef, useState } from 'react';
import { BrowserMultiFormatReader } from '@zxing/browser';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Camera, X } from 'lucide-react';
import { toast } from 'sonner';

export default function BarcodeScanner({
  open,
  onClose,
  onDetected,
}: {
  open: boolean;
  onClose: () => void;
  onDetected: (code: string) => void;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const readerRef = useRef<BrowserMultiFormatReader | null>(null);
  const controlsRef = useRef<{ stop: () => void } | null>(null);
  const [error, setError] = useState('');
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [deviceId, setDeviceId] = useState('');

  useEffect(() => {
    if (!open) return;
    setError('');
    const reader = new BrowserMultiFormatReader();
    readerRef.current = reader;

    const init = async () => {
      try {
        const list = await BrowserMultiFormatReader.listVideoInputDevices();
        setDevices(list);
        const rear = list.find((d) => /back|rear|environment/i.test(d.label)) || list[list.length - 1];
        const id = rear?.deviceId ?? '';
        setDeviceId(id);
        await startScan(id);
      } catch (e) {
        setError('Tidak bisa akses kamera: ' + (e instanceof Error ? e.message : String(e)));
      }
    };

    const startScan = async (id: string) => {
      try {
        if (controlsRef.current) { try { controlsRef.current.stop(); } catch {} }
        const controls = await reader.decodeFromVideoDevice(
          id || undefined,
          videoRef.current!,
          (result, err) => {
            if (result) {
              const text = result.getText();
              try { controls.stop(); } catch {}
              onDetected(text);
              onClose();
            }
          }
        );
        controlsRef.current = controls as { stop: () => void };
      } catch (e) {
        setError('Gagal start kamera: ' + (e instanceof Error ? e.message : String(e)));
      }
    };

    init();
    return () => {
      try { controlsRef.current?.stop(); } catch {}
    };
  }, [open]);

  const switchCamera = async (id: string) => {
    setDeviceId(id);
    if (!readerRef.current) return;
    try { controlsRef.current?.stop(); } catch {}
    try {
      const controls = await readerRef.current.decodeFromVideoDevice(
        id || undefined, videoRef.current!,
        (result) => {
          if (result) {
            try { controls.stop(); } catch {}
            onDetected(result.getText());
            onClose();
          }
        }
      );
      controlsRef.current = controls;
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="max-w-lg">
        <DialogHeader><DialogTitle className="flex items-center gap-2"><Camera className="w-5 h-5 text-orange-500" /> Scan Barcode</DialogTitle></DialogHeader>
        {error && <div className="bg-red-50 text-red-700 text-sm p-3 rounded">{error}</div>}
        <div className="relative bg-black rounded overflow-hidden aspect-[4/3]">
          <video ref={videoRef} className="w-full h-full object-cover" muted playsInline></video>
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
            <div className="w-3/4 h-1/3 border-2 border-orange-400 rounded-lg shadow-[0_0_20px_rgba(249,115,22,0.5)]"></div>
          </div>
        </div>
        {devices.length > 1 && (
          <select value={deviceId} onChange={e => switchCamera(e.target.value)} className="w-full border rounded px-3 py-2 text-sm">
            {devices.map(d => <option key={d.deviceId} value={d.deviceId}>{d.label || 'Camera'}</option>)}
          </select>
        )}
        <p className="text-xs text-slate-500 text-center">Arahkan barcode ke dalam kotak. Auto detect.</p>
        <Button variant="outline" onClick={onClose} className="w-full"><X className="w-4 h-4 mr-2" /> Tutup</Button>
      </DialogContent>
    </Dialog>
  );
}

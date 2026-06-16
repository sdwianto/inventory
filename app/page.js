'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { PasswordInput } from '@/components/PasswordInput';
import { Label } from '@/components/ui/label';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Store, ShoppingCart, Package, BarChart3, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { setUser, getUser, syncSessionUser } from '@/lib/auth-client';

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (getUser()) {
      router.replace('/dashboard');
      return;
    }
    syncSessionUser().then((u) => {
      if (u) router.replace('/dashboard');
    });
  }, [router]);

  const handleLogin = async (e) => {
    e.preventDefault();
    setLoading(true);
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Gagal login');
      setUser(data.user);
      toast.success(`Selamat datang, ${data.user.name}!`);
      router.replace('/dashboard');
    } catch (err) {
      toast.error(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className='min-h-screen bg-gradient-to-br from-slate-900 via-slate-800 to-orange-900 flex items-center justify-center p-4'>
      <div className='max-w-5xl w-full grid md:grid-cols-2 gap-8 items-center'>
        {/* Left: branding */}
        <div className='text-white space-y-6 hidden md:block'>
          <div className='flex items-center gap-3'>
            <div className='w-12 h-12 rounded-xl bg-orange-500 flex items-center justify-center'>
              <Store className='w-7 h-7' />
            </div>
            <div>
              <h1 className='text-3xl font-bold'>Inventory App</h1>
              <p className='text-slate-300 text-sm'>Customer Gudang & GRN</p>
            </div>
          </div>
          <h2 className='text-4xl font-bold leading-tight'>
            Terima Barang dari
            <br />
            sales.app — Otomatis via Webhook
          </h2>
          <p className='text-slate-300 leading-relaxed'>
            Aplikasi kasir lengkap dengan keyboard shortcut, multi-antrian,
            cetak struk thermal, dan laporan penjualan real-time.
          </p>
          <div className='grid grid-cols-2 gap-4 pt-4'>
            <div className='flex items-start gap-3'>
              <ShoppingCart className='w-5 h-5 text-orange-400 mt-0.5' />
              <div>
                <div className='font-semibold text-sm'>POS Cepat</div>
                <div className='text-xs text-slate-400'>
                  Shortcut F1-F12, scan barcode
                </div>
              </div>
            </div>
            <div className='flex items-start gap-3'>
              <Package className='w-5 h-5 text-orange-400 mt-0.5' />
              <div>
                <div className='font-semibold text-sm'>Manajemen Stok</div>
                <div className='text-xs text-slate-400'>
                  Auto-decrement & alert
                </div>
              </div>
            </div>
            <div className='flex items-start gap-3'>
              <BarChart3 className='w-5 h-5 text-orange-400 mt-0.5' />
              <div>
                <div className='font-semibold text-sm'>Laporan Real-time</div>
                <div className='text-xs text-slate-400'>
                  KPI & grafik penjualan
                </div>
              </div>
            </div>
            <div className='flex items-start gap-3'>
              <Store className='w-5 h-5 text-orange-400 mt-0.5' />
              <div>
                <div className='font-semibold text-sm'>Struk Thermal</div>
                <div className='text-xs text-slate-400'>
                  58mm / 80mm support
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Right: login form */}
        <Card className='shadow-2xl'>
          <CardHeader>
            <CardTitle className='text-2xl'>Masuk ke Akun</CardTitle>
            <CardDescription>
              Masuk dengan email dan password yang telah diberikan
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleLogin} className='space-y-4'>
              <div className='space-y-2'>
                <Label htmlFor='email'>Email</Label>
                <Input
                  id='email'
                  type='email'
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                  autoComplete='username'
                />
              </div>
              <div className='space-y-2'>
                <Label htmlFor='password'>Password</Label>
                <PasswordInput
                  id='password'
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  autoComplete='current-password'
                />
              </div>
              <Button
                type='submit'
                className='w-full bg-orange-500 hover:bg-orange-600'
                disabled={loading}
              >
                {loading ? (
                  <>
                    <Loader2 className='w-4 h-4 mr-2 animate-spin' /> Memuat...
                  </>
                ) : (
                  'Masuk'
                )}
              </Button>
            </form>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

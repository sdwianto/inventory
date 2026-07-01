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
import { Store, Package, BarChart3, Loader2, Truck, Warehouse } from 'lucide-react';
import { toast } from 'sonner';
import { setUser, getUser, syncSessionUser } from '@/lib/auth-client';
import type { LoginTenantOption } from '@/lib/api/user-email';

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [tenantPick, setTenantPick] = useState<LoginTenantOption[]>([]);
  const [selectedTenantId, setSelectedTenantId] = useState('');

  const loginRedirect = () => {
    if (typeof window === 'undefined') return '/dashboard';
    const next = new URLSearchParams(window.location.search).get('next');
    return next && next.startsWith('/') && !next.startsWith('//') ? next : '/dashboard';
  };

  useEffect(() => {
    if (getUser()) {
      router.replace(loginRedirect());
      return;
    }
    syncSessionUser().then((u) => {
      if (u) router.replace(loginRedirect());
    });
  }, [router]);

  const submitLogin = async (tenantId) => {
    setLoading(true);
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email,
          password,
          ...(tenantId ? { tenantId } : {}),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Gagal login');
      if (data.needsTenantPick && Array.isArray(data.tenants) && data.tenants.length > 0) {
        setTenantPick(data.tenants);
        setSelectedTenantId(data.tenants[0]?.tenantId || '');
        toast.message('Pilih tenant untuk melanjutkan login');
        return;
      }
      setTenantPick([]);
      setUser(data.user);
      toast.success(`Selamat datang, ${data.user.name}!`);
      router.replace(loginRedirect());
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  const handleLogin = async (e) => {
    e.preventDefault();
    await submitLogin(tenantPick.length > 0 ? selectedTenantId : undefined);
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
            Kelola penerimaan barang (GRN), stok gudang kering & basah, PO ke vendor,
            release inventory, dan integrasi otomatis dengan sales.app.
          </p>
          <div className='grid grid-cols-2 gap-4 pt-4'>
            <div className='flex items-start gap-3'>
              <Truck className='w-5 h-5 text-orange-400 mt-0.5' />
              <div>
                <div className='font-semibold text-sm'>Penerimaan GRN</div>
                <div className='text-xs text-slate-400'>
                  Webhook dari sales.app
                </div>
              </div>
            </div>
            <div className='flex items-start gap-3'>
              <Warehouse className='w-5 h-5 text-orange-400 mt-0.5' />
              <div>
                <div className='font-semibold text-sm'>Gudang Kering & Basah</div>
                <div className='text-xs text-slate-400'>
                  Saldo & release per gudang
                </div>
              </div>
            </div>
            <div className='flex items-start gap-3'>
              <Package className='w-5 h-5 text-orange-400 mt-0.5' />
              <div>
                <div className='font-semibold text-sm'>PO & Hutang Vendor</div>
                <div className='text-xs text-slate-400'>
                  Approval & 3-way match
                </div>
              </div>
            </div>
            <div className='flex items-start gap-3'>
              <BarChart3 className='w-5 h-5 text-orange-400 mt-0.5' />
              <div>
                <div className='font-semibold text-sm'>Dashboard Pengadaan</div>
                <div className='text-xs text-slate-400'>
                  KPI & grafik stok
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
              {tenantPick.length > 0 && (
                <div className='space-y-2'>
                  <Label htmlFor='tenant'>Tenant</Label>
                  <select
                    id='tenant'
                    className='flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm'
                    value={selectedTenantId}
                    onChange={(e) => setSelectedTenantId(e.target.value)}
                  >
                    {tenantPick.map((t) => (
                      <option key={t.tenantId} value={t.tenantId}>
                        {t.tenantName} ({t.role})
                      </option>
                    ))}
                  </select>
                </div>
              )}
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

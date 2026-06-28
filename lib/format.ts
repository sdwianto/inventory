// Currency & date formatters (Indonesia)

type DateInput = string | number | Date | null | undefined;
type NumberInput = string | number | null | undefined;

export const formatIDR = (n: NumberInput): string => {
  const num = Number(n || 0);
  return new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR', minimumFractionDigits: 0 }).format(num);
};

export const formatNumber = (n: NumberInput): string => {
  return new Intl.NumberFormat('id-ID').format(Number(n || 0));
};

export const formatDate = (d: DateInput): string => {
  if (!d) return '';
  const date = new Date(d);
  return date.toLocaleDateString('id-ID', { day: '2-digit', month: '2-digit', year: 'numeric' });
};

export const formatDateTime = (d: DateInput): string => {
  if (!d) return '';
  const date = new Date(d);
  return date.toLocaleString('id-ID', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
};

export const formatTime = (d: DateInput): string => {
  if (!d) return '';
  const date = new Date(d);
  return date.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
};

export const generateNoNota = (): string => {
  const now = new Date();
  const yy = String(now.getFullYear()).slice(-2);
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  const rand = String(Math.floor(Math.random() * 1000000)).padStart(6, '0');
  return `TK${yy}${mm}${dd}${rand}`;
};

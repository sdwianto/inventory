import type { CSSProperties } from 'react';
import { darken, readableTextOn } from '@/lib/brand-color';
import type { DocumentVariant, LayoutTokens, TableStyle } from './types';

export interface BrandPalette {
  brand: string;
  brandBorder: string;
  brandAccent: string;
  brandHeaderText: string;
}

export function brandPalette(brand: string): BrandPalette {
  return {
    brand,
    brandBorder: darken(brand, 0.12),
    brandAccent: darken(brand, 0.28),
    brandHeaderText: readableTextOn(brand),
  };
}

export function effectiveBrand(baseBrand: string, tokens: LayoutTokens): string {
  return tokens.extras.monochrome ? '#1e293b' : baseBrand;
}

export function densityPad(tokens: LayoutTokens): string {
  if (tokens.density === 'compact') return 'p-3';
  if (tokens.density === 'airy') return 'p-10';
  return 'p-8';
}

/** Padding lembar — jangan gabung `p-*` dengan `pl-*` (Tailwind menimpa, pita kiri menutupi teks). */
export function sheetPad(tokens: LayoutTokens): string {
  const compact = tokens.density === 'compact';
  const airy = tokens.density === 'airy';
  const y = compact ? 'py-3' : airy ? 'py-10' : 'py-8';
  const r = compact ? 'pr-3' : airy ? 'pr-10' : 'pr-8';
  if (tokens.header === 'flag') return `${y} ${r} !pl-[6.75rem]`;
  if (tokens.header === 'sidebar') return `${y} ${r} !pl-6`;
  if (tokens.header === 'topBar') {
    const x = compact ? 'px-3' : airy ? 'px-10' : 'px-8';
    const b = compact ? 'pb-3' : airy ? 'pb-10' : 'pb-8';
    return `!pt-3 ${b} ${x}`;
  }
  return densityPad(tokens);
}

export function sheetSidePad(tokens: LayoutTokens): string {
  return sheetPad(tokens);
}

export function densityText(tokens: LayoutTokens): string {
  if (tokens.density === 'compact') return 'text-[10px] leading-snug';
  return 'text-xs';
}

/** Kartu Pelanggan/Referensi — dilewati model Niaga Compact (meta sudah di header). */
export function usesInfoCards(tokens: LayoutTokens): boolean {
  return tokens.info !== 'kvGrid';
}

export function infoBoxClass(tokens: LayoutTokens): string {
  if (tokens.info === 'stamp' || tokens.header === 'boxed') {
    return 'border-2 rounded-none bg-white p-3';
  }
  if (tokens.info === 'inline') {
    return 'border-0 border-l-2 bg-transparent rounded-none pl-3 py-1';
  }
  return 'bg-slate-50 border rounded-lg p-3';
}

export function tableHeadStyle(table: TableStyle, palette: BrandPalette): CSSProperties {
  if (table === 'hairline') {
    return {
      backgroundColor: 'transparent',
      color: palette.brandAccent,
      borderTopWidth: 1,
      borderBottomWidth: 1,
      borderColor: palette.brand,
      fontWeight: 700,
    };
  }
  if (table === 'minimal') {
    return { backgroundColor: 'transparent', color: palette.brandAccent, borderColor: palette.brand };
  }
  if (table === 'lined') {
    return {
      backgroundColor: 'transparent',
      color: palette.brandAccent,
      borderBottomWidth: 2,
      borderColor: palette.brand,
    };
  }
  return { backgroundColor: palette.brand, color: palette.brandHeaderText, borderColor: palette.brandBorder };
}

export function cellBorder(table: TableStyle): string {
  if (table === 'hairline') return 'border-0';
  if (table === 'minimal') return 'border-0 border-b border-slate-200';
  return 'border border-slate-200';
}

export function rowClass(table: TableStyle, index: number): string {
  if (table === 'zebra' || table === 'filled') return index % 2 ? 'bg-slate-50' : '';
  return '';
}

export function headerRuleStyle(tokens: LayoutTokens, brand: string): CSSProperties {
  if (tokens.extras.doubleRule) {
    return { borderColor: brand, borderBottomWidth: 4, borderStyle: 'double' };
  }
  return { borderColor: brand };
}

export function variantArticleClass(variant: DocumentVariant, className = ''): string {
  return `doc-variant doc-variant-${variant.id} bg-white text-slate-900 mx-auto relative ${sheetPad(variant.tokens)} ${className}`;
}

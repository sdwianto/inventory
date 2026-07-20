/**
 * Capability Ownership + Operational Surface (ADR-002).
 * Capability → Policy → Adapter. Domain logic stays with the owner.
 */

import type { KaCategory } from '@/lib/kitchen-assurance/categories';

export type KaCapabilityOwner =
  | 'FOOD_PRODUCTION'
  | 'MAINTENANCE'
  | 'QUALITY'
  | 'INVENTORY'
  | 'KITCHEN_ASSURANCE';

export type KaAdapterKey =
  | 'cold-chain'
  | 'cleaning'
  | 'equipment-inspection'
  | 'quality-complaint'
  | 'haccp'
  | 'qc';

export interface KaCapabilityDef {
  id: string;
  nama: string;
  owner: KaCapabilityOwner;
  category: KaCategory;
  adapterKey: KaAdapterKey;
  /** Deep-link into owner UI */
  ownerHref: string;
  /** Surface routes inside Kitchen Assurance */
  surfaceRoutes: string[];
  phase0: boolean;
}

export const KA_CAPABILITIES: KaCapabilityDef[] = [
  {
    id: 'cold-chain',
    nama: 'Cold Chain',
    owner: 'FOOD_PRODUCTION',
    category: 'FOOD',
    adapterKey: 'cold-chain',
    ownerHref: '/food-production/cold-chain',
    surfaceRoutes: ['/kitchen-assurance/monitoring', '/kitchen-assurance'],
    phase0: true,
  },
  {
    id: 'haccp',
    nama: 'HACCP',
    owner: 'FOOD_PRODUCTION',
    category: 'FOOD',
    adapterKey: 'haccp',
    ownerHref: '/food-production/haccp',
    surfaceRoutes: ['/kitchen-assurance/monitoring'],
    phase0: false,
  },
  {
    id: 'qc',
    nama: 'Quality Control',
    owner: 'FOOD_PRODUCTION',
    category: 'FOOD',
    adapterKey: 'qc',
    ownerHref: '/food-production/qc',
    surfaceRoutes: ['/kitchen-assurance/monitoring'],
    phase0: false,
  },
  {
    id: 'cleaning',
    nama: 'Cleaning Schedule',
    owner: 'KITCHEN_ASSURANCE',
    category: 'OPERATION',
    adapterKey: 'cleaning',
    ownerHref: '/kitchen-assurance/monitoring',
    surfaceRoutes: ['/kitchen-assurance/monitoring', '/food-production'],
    phase0: true,
  },
  {
    id: 'equipment-inspection',
    nama: 'Equipment Inspection',
    owner: 'MAINTENANCE',
    category: 'EQUIPMENT',
    adapterKey: 'equipment-inspection',
    ownerHref: '/maintenance/jadwal',
    surfaceRoutes: ['/kitchen-assurance/monitoring', '/kitchen-assurance'],
    phase0: true,
  },
  {
    id: 'quality-complaint',
    nama: 'Food Complaint / Recall',
    owner: 'QUALITY',
    category: 'FOOD',
    adapterKey: 'quality-complaint',
    ownerHref: '/kitchen-assurance/cases',
    surfaceRoutes: ['/kitchen-assurance/monitoring', '/kitchen-assurance/cases'],
    phase0: true,
  },
];

export const KA_OWNER_LABELS: Record<KaCapabilityOwner, string> = {
  FOOD_PRODUCTION: 'Food Production',
  MAINTENANCE: 'Maintenance',
  QUALITY: 'Quality',
  INVENTORY: 'Inventory',
  KITCHEN_ASSURANCE: 'Kitchen Assurance',
};

export function getCapability(id: string): KaCapabilityDef | undefined {
  return KA_CAPABILITIES.find((c) => c.id === id);
}

export function phase0Capabilities(): KaCapabilityDef[] {
  return KA_CAPABILITIES.filter((c) => c.phase0);
}

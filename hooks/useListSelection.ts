'use client';

import { useCallback, useState } from 'react';

export function useListSelection<T extends { id: string }>(
  getId: (item: T) => string = (item) => item.id,
) {
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());

  const toggle = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const toggleAll = useCallback((items: T[]) => {
    setSelectedIds((prev) => {
      if (items.length > 0 && prev.size === items.length) return new Set();
      return new Set(items.map(getId));
    });
  }, [getId]);

  const clear = useCallback(() => setSelectedIds(new Set()), []);

  const isSelected = useCallback((id: string) => selectedIds.has(id), [selectedIds]);

  return {
    selectedIds,
    setSelectedIds,
    toggle,
    toggleAll,
    clear,
    isSelected,
    someSelected: selectedIds.size > 0,
    count: selectedIds.size,
    ids: () => [...selectedIds],
  };
}

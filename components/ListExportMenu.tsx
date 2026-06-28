'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Download, ChevronDown, FileSpreadsheet, FileText } from 'lucide-react';
import type { ListExportFormat } from '@/lib/run-list-export';

interface ListExportMenuProps {
  onExport: (format: ListExportFormat) => void | Promise<void>;
  disabled?: boolean;
}

export default function ListExportMenu({ onExport, disabled = false }: ListExportMenuProps) {
  const [exporting, setExporting] = useState(false);

  const handle = async (format: ListExportFormat) => {
    if (exporting) return;
    setExporting(true);
    try {
      await onExport(format);
    } finally {
      setExporting(false);
    }
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" disabled={disabled || exporting}>
          <Download className="w-4 h-4 mr-2" />
          {exporting ? 'Mengekspor…' : 'Download'}
          <ChevronDown className="w-4 h-4 ml-2 opacity-60" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onClick={() => handle('csv')}>
          <FileText className="w-4 h-4 mr-2" />
          {' '}
          CSV
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => handle('xlsx')}>
          <FileSpreadsheet className="w-4 h-4 mr-2" />
          {' '}
          Excel (.xlsx)
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => handle('pdf')}>
          <FileText className="w-4 h-4 mr-2" />
          {' '}
          PDF
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

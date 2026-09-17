/**
 * Client-side PDF export for Meeting Record (MoM).
 */

import { jsPDF } from 'jspdf';
import autoTable from 'jspdf-autotable';
import {
  MEETING_ACTION_STATUS_LABELS,
  MEETING_MATERIAL_KIND_LABELS,
  MEETING_RECORD_STATUS_LABELS,
  type MeetingActionItem,
  type MeetingMaterial,
  type MeetingRecordStatus,
} from '@/lib/kitchen-assurance/meeting-record';

export type MeetingRecordPdfInput = {
  noDokumen: string;
  title: string;
  topicNama: string;
  meetingAt: string | Date;
  location?: string;
  attendees?: string[];
  agenda?: string;
  notes?: string;
  actionItems?: MeetingActionItem[];
  materials?: MeetingMaterial[];
  photos?: string[];
  status: MeetingRecordStatus;
  createdByName?: string;
  kitchenNama?: string;
};

function formatMeetingAt(raw: string | Date): string {
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return String(raw || '—');
  return d.toLocaleString('id-ID', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function wrapText(doc: jsPDF, text: string, x: number, y: number, maxWidth: number, lineHeight = 5): number {
  const lines = doc.splitTextToSize(String(text || '—'), maxWidth) as string[];
  doc.text(lines, x, y);
  return y + lines.length * lineHeight;
}

export async function downloadMeetingRecordPdf(docIn: MeetingRecordPdfInput): Promise<void> {
  const pdf = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
  const pageWidth = pdf.internal.pageSize.getWidth();
  const margin = 14;
  const contentW = pageWidth - margin * 2;
  let y = 14;

  pdf.setFontSize(16);
  pdf.setFont('helvetica', 'bold');
  pdf.text('Meeting Record (MoM)', margin, y);
  y += 7;

  pdf.setFontSize(10);
  pdf.setFont('helvetica', 'normal');
  pdf.setTextColor(80);
  pdf.text(`No: ${docIn.noDokumen}  ·  Status: ${MEETING_RECORD_STATUS_LABELS[docIn.status]}`, margin, y);
  y += 5;
  pdf.text(`Diekspor: ${new Date().toLocaleString('id-ID')}`, margin, y);
  pdf.setTextColor(0);
  y += 8;

  pdf.setDrawColor(200);
  pdf.line(margin, y, pageWidth - margin, y);
  y += 8;

  pdf.setFont('helvetica', 'bold');
  pdf.setFontSize(12);
  y = wrapText(pdf, docIn.title || '—', margin, y, contentW, 6);
  y += 3;

  pdf.setFontSize(9);
  pdf.setFont('helvetica', 'normal');
  const meta: Array<[string, string]> = [
    ['Kategori / Topik', docIn.topicNama || '—'],
    ['Waktu', formatMeetingAt(docIn.meetingAt)],
    ['Lokasi', docIn.location || '—'],
    ['Dapur', docIn.kitchenNama || '—'],
    ['Dicatat oleh', docIn.createdByName || '—'],
  ];
  for (const [label, value] of meta) {
    pdf.setFont('helvetica', 'bold');
    pdf.text(`${label}:`, margin, y);
    pdf.setFont('helvetica', 'normal');
    y = wrapText(pdf, value, margin + 38, y, contentW - 38, 4.5);
    y += 2;
  }

  y += 2;
  pdf.setFont('helvetica', 'bold');
  pdf.text('Peserta', margin, y);
  y += 5;
  pdf.setFont('helvetica', 'normal');
  const attendees = (docIn.attendees || []).filter(Boolean);
  y = wrapText(pdf, attendees.length ? attendees.join(', ') : '—', margin, y, contentW, 4.5);
  y += 4;

  pdf.setFont('helvetica', 'bold');
  pdf.text('Agenda', margin, y);
  y += 5;
  pdf.setFont('helvetica', 'normal');
  y = wrapText(pdf, docIn.agenda || '—', margin, y, contentW, 4.5);
  y += 4;

  pdf.setFont('helvetica', 'bold');
  pdf.text('Notulen / Keputusan', margin, y);
  y += 5;
  pdf.setFont('helvetica', 'normal');
  y = wrapText(pdf, docIn.notes || '—', margin, y, contentW, 4.5);
  y += 6;

  const items = docIn.actionItems || [];
  pdf.setFont('helvetica', 'bold');
  pdf.setFontSize(10);
  pdf.text(`Action Items (${items.length})`, margin, y);
  y += 2;

  autoTable(pdf, {
    startY: y + 2,
    margin: { left: margin, right: margin },
    head: [['#', 'Deskripsi', 'PIC', 'Due', 'Status']],
    body: items.length
      ? items.map((a, i) => [
          String(i + 1),
          a.text,
          a.picName || '—',
          a.dueDate || '—',
          MEETING_ACTION_STATUS_LABELS[a.status] || a.status,
        ])
      : [['—', 'Tidak ada action item', '—', '—', '—']],
    styles: { fontSize: 8, cellPadding: 1.5, overflow: 'linebreak' },
    headStyles: { fillColor: [234, 88, 12], textColor: 255, fontStyle: 'bold' },
    columnStyles: {
      0: { cellWidth: 8 },
      1: { cellWidth: 78 },
      2: { cellWidth: 32 },
      3: { cellWidth: 24 },
      4: { cellWidth: 22 },
    },
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let afterTableY = ((pdf as any).lastAutoTable?.finalY as number | undefined) ?? y + 20;
  afterTableY += 8;

  if (afterTableY > pdf.internal.pageSize.getHeight() - 40) {
    pdf.addPage();
    afterTableY = 20;
  }

  const materials = docIn.materials || [];
  pdf.setFont('helvetica', 'bold');
  pdf.setFontSize(10);
  pdf.text(`Bahan Meeting (${materials.length})`, margin, afterTableY);

  autoTable(pdf, {
    startY: afterTableY + 2,
    margin: { left: margin, right: margin },
    head: [['#', 'Judul', 'Jenis', 'Referensi']],
    body: materials.length
      ? materials.map((m, i) => [
          String(i + 1),
          m.title || '—',
          MEETING_MATERIAL_KIND_LABELS[m.kind] || m.kind,
          m.kind === 'LINK' ? m.url : (m.originalName || m.url),
        ])
      : [['—', 'Tidak ada bahan', '—', '—']],
    styles: { fontSize: 8, cellPadding: 1.5, overflow: 'linebreak' },
    headStyles: { fillColor: [15, 118, 110], textColor: 255, fontStyle: 'bold' },
    columnStyles: {
      0: { cellWidth: 8 },
      1: { cellWidth: 50 },
      2: { cellWidth: 18 },
      3: { cellWidth: 88 },
    },
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  afterTableY = ((pdf as any).lastAutoTable?.finalY as number | undefined) ?? afterTableY + 20;
  afterTableY += 8;

  if (afterTableY > pdf.internal.pageSize.getHeight() - 20) {
    pdf.addPage();
    afterTableY = 20;
  }

  const photoCount = (docIn.photos || []).filter(Boolean).length;
  pdf.setFontSize(9);
  pdf.setFont('helvetica', 'normal');
  pdf.text(
    `Lampiran foto bukti: ${photoCount} file${photoCount ? ' (lihat di aplikasi — tidak tertanam di PDF)' : ''}`,
    margin,
    afterTableY,
  );

  const stamp = new Date().toISOString().slice(0, 10);
  const safeNo = String(docIn.noDokumen || 'MOM').replace(/[^\w.-]+/g, '_');
  pdf.save(`mom-${safeNo}-${stamp}.pdf`);
}

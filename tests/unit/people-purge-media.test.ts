import { describe, expect, it, vi } from 'vitest';

const deleteMediaFile = vi.fn(async () => {});

vi.mock('@/lib/api/media-storage', () => ({
  deleteMediaFile: (...args: unknown[]) => deleteMediaFile(...args),
}));

import { personAttachmentFilenames, purgePersonMedia } from '@/lib/people/purge-media';

describe('person attachment purge', () => {
  it('collects non-empty filenames', () => {
    expect(personAttachmentFilenames([
      { attachments: [{ filename: 'kdp-a.jpg' }, { filename: '  ' }, {}] },
      { attachments: [{ filename: 'kdp-b.pdf' }] },
    ])).toEqual(['kdp-a.jpg', 'kdp-b.pdf']);
  });

  it('deletes media from people and kitchen_people before tenant wipe', async () => {
    deleteMediaFile.mockClear();
    const people = [{ tenantId: 't1', attachments: [{ filename: 'kdp-1.jpg' }] }];
    const legacy = [{ tenantId: 't1', attachments: [{ filename: 'kperson-old.pdf' }] }];
    const db = {
      collection: (name: string) => ({
        find: () => ({
          project: () => ({
            toArray: async () => (name === 'people' ? people : legacy),
          }),
        }),
      }),
    };
    const n = await purgePersonMedia(db as never, 't1');
    expect(n).toBe(2);
    expect(deleteMediaFile).toHaveBeenCalledWith('t1', 'kdp-1.jpg');
    expect(deleteMediaFile).toHaveBeenCalledWith('t1', 'kperson-old.pdf');
  });
});

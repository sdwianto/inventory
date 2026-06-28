import { describe, expect, it } from 'vitest';
import {
  validateBase64Image,
  validateBase64Images,
  MAX_WR_PHOTOS,
} from '@/lib/api/image-base64';

const SAMPLE = 'data:image/jpeg;base64,/9j/4AAQ';

describe('image-base64', () => {
  it('accepts empty as null', () => {
    expect(validateBase64Image('')).toBeNull();
    expect(validateBase64Image(null)).toBeNull();
  });

  it('rejects invalid format', () => {
    const r = validateBase64Image('not-an-image');
    expect(r).toHaveProperty('error');
  });

  it('accepts valid data url', () => {
    expect(validateBase64Image(SAMPLE)).toBe(SAMPLE);
  });

  it('validates photo array count', () => {
    const tooMany = Array.from({ length: MAX_WR_PHOTOS + 1 }, () => SAMPLE);
    const r = validateBase64Images(tooMany);
    expect(r).toHaveProperty('error');
    expect(validateBase64Images([SAMPLE, SAMPLE])).toEqual([SAMPLE, SAMPLE]);
  });
});

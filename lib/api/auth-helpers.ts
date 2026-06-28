// Password hashing utilities (bcryptjs)
// Supports both fresh hashed passwords and legacy plain-text auto-migration.

import bcrypt from 'bcryptjs';

export const isHashed = (s: string | null | undefined): boolean =>
  typeof s === 'string' && (s.startsWith('$2a$') || s.startsWith('$2b$') || s.startsWith('$2y$'));

export const hashPassword = async (plain: string): Promise<string> => bcrypt.hash(plain, 10);

export const verifyPassword = async (
  plain: string,
  stored: string | null | undefined,
): Promise<boolean> => {
  if (!stored) return false;
  if (isHashed(stored)) return bcrypt.compare(plain, stored);
  return plain === stored;
};

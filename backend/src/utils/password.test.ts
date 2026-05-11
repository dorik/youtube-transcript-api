import { describe, expect, it } from 'vitest';
import { hashPassword, verifyPassword } from './password';

describe('password hashing', { timeout: 20_000 }, () => {
  it('produces a bcrypt-shaped hash', async () => {
    const hash = await hashPassword('correct horse battery staple');
    // bcrypt hashes start with $2a$, $2b$, or $2y$ followed by cost
    expect(hash).toMatch(/^\$2[aby]\$\d{2}\$/);
  });

  it('does not store the password in the hash', async () => {
    const password = 'super-secret-123';
    const hash = await hashPassword(password);
    expect(hash).not.toContain(password);
  });

  it('produces a different hash each call (salted)', async () => {
    const password = 'same-password';
    const a = await hashPassword(password);
    const b = await hashPassword(password);
    expect(a).not.toBe(b);
  });

  it('verifyPassword returns true for the matching password', async () => {
    const hash = await hashPassword('correct horse battery staple');
    await expect(verifyPassword('correct horse battery staple', hash)).resolves.toBe(true);
  });

  it('verifyPassword returns false for the wrong password', async () => {
    const hash = await hashPassword('correct horse battery staple');
    await expect(verifyPassword('wrong password', hash)).resolves.toBe(false);
  });

  it('verifyPassword is case-sensitive', async () => {
    const hash = await hashPassword('CaseSensitive');
    await expect(verifyPassword('casesensitive', hash)).resolves.toBe(false);
  });
});

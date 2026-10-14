import { describe, expect, it } from 'vitest';
import { PasswordHasher } from '@nestjs/authentication';
import { PasswordsService } from '../src/modules/users/passwords.service.js';

const password = 'test password phrase';

describe('Package-backed password utilities', () => {
  it('uses production scrypt defaults and verifies a real hash', async () => {
    const service = new PasswordsService(new PasswordHasher());
    const hash = await service.hash(password);
    expect(hash.startsWith('$scrypt$ln=17,r=8,p=1$')).toBe(true);
    expect(await service.verify(password, hash)).toBe(true);
    expect(await service.verify('incorrect password phrase', hash)).toBe(false);
  });
  it('salts hashes independently and preserves package Unicode normalization', async () => {
    const service = new PasswordsService(new PasswordHasher({ logN: 10 }));
    const first = await service.hash('caf\u00e9 password phrase');
    const second = await service.hash('caf\u00e9 password phrase');
    expect(first === second).toBe(false);
    expect(await service.verify('cafe\u0301 password phrase', first)).toBe(
      true,
    );
  });
  it('returns false for absent, malformed and tampered hashes', async () => {
    const service = new PasswordsService(new PasswordHasher({ logN: 10 }));
    expect(await service.verify(password, undefined)).toBe(false);
    expect(await service.verify(password, 'invalid')).toBe(false);
    const hash = await service.hash(password);
    const digestStart = hash.lastIndexOf('$') + 1;
    const replacement = hash[digestStart] === 'A' ? 'B' : 'A';
    expect(
      await service.verify(
        password,
        `${hash.slice(0, digestStart)}${replacement}${hash.slice(digestStart + 1)}`,
      ),
    ).toBe(false);
  });
  it('rejects invalid passwords before hashing', () => {
    const service = new PasswordsService(new PasswordHasher({ logN: 10 }));
    expect(() => service.hash('short')).toThrow();
  });
});

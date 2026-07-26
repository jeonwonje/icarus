import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { mailConfig } from '../../../src/modules/mail/config.js';

describe('mail config', () => {
  it('throws when drop dir missing (non-selftest)', () => {
    assert.throws(() => mailConfig({ selftest: false, dropDir: undefined }), /ICARUS_MAIL_DROP/);
  });

  it('accepts valid env in non-selftest', () => {
    const c = mailConfig({ selftest: false, dropDir: 'C:\\mail\\drop' });
    assert.equal(c.dropDir, 'C:\\mail\\drop');
  });

  it('selftest returns fixture path under state/', () => {
    const c = mailConfig({ selftest: true });
    assert.match(c.dropDir, /selftest-mail-drop$/);
  });
});

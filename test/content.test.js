const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const content = require('../src/content');
const http = require('../src/util/http');
const servers = require('../src/servers');

for (const type of ['paper', 'velocity', 'fabric']) {
  test(`${type} updates select stable releases even when a newer snapshot exists`, async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'craftpanel-content-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    t.mock.method(servers, 'dir', () => root);
    const folder = path.join(root, type === 'fabric' ? 'mods' : 'plugins');
    fs.mkdirSync(folder);

    const installed = {};
    const available = {};
    const release = (id) => ({ id, version_number: id, version_type: 'release' });
    const snapshot = { id: 'snapshot', version_number: '5.12.2-SNAPSHOT+1109', version_type: 'beta' };
    const cases = [
      { file: 'current.jar', current: '5.12.1', versions: [snapshot, release('5.12.1')] },
      { file: 'outdated.jar', current: '5.12.0', versions: [snapshot, release('5.12.1')] },
      { file: 'preview-only.jar', current: 'preview', versions: [snapshot] },
    ];
    for (const c of cases) {
      fs.writeFileSync(path.join(folder, c.file), c.file);
      const hash = crypto.createHash('sha1').update(c.file).digest('hex');
      installed[hash] = { id: c.current, project_id: c.file, version_number: c.current };
      available[hash] = c.versions;
    }
    t.mock.method(http, 'getJson', async () => []);
    t.mock.method(http, 'postJson', async (url, body) => {
      if (url.endsWith('/version_files')) return installed;
      assert.ok(url.endsWith('/version_files/update'));
      assert.equal(body.algorithm, 'sha1');
      assert.deepEqual(body.loaders, content.LOADERS[type]);
      assert.deepEqual(body.game_versions, type === 'velocity' ? undefined : ['1.21.4']);
      // Emulate Modrinth's channel filtering over newest-first versions.
      return Object.fromEntries(body.hashes.flatMap((hash) => {
        const version = available[hash].find((v) => !body.version_types || body.version_types.includes(v.version_type));
        return version ? [[hash, version]] : [];
      }));
    });

    assert.deepEqual(await content.checkUpdates({ id: 'test', type, mcVersion: '1.21.4' }), {
      'outdated.jar': { versionId: '5.12.1', versionNumber: '5.12.1' },
    });
  });
}

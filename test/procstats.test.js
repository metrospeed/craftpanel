const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const { test } = require('node:test');
const { system } = require('../src/util/procstats');

const GiB = 1024 ** 3;

test('host memory includes reclaimable cache in available capacity', (t) => {
  t.mock.method(os, 'totalmem', () => 16 * GiB);
  t.mock.method(os, 'freemem', () => GiB);
  t.mock.method(fs, 'readFileSync', () => 'MemTotal: 16777216 kB\nMemFree: 1048576 kB\nMemAvailable: 4194304 kB\nCached: 3145728 kB\n');

  const stats = system();
  assert.equal(stats.totalMem, 16 * GiB);
  assert.equal(stats.freeMem, GiB);
  assert.equal(stats.availableMem, 4 * GiB);
  assert.equal(stats.totalMem - stats.availableMem, 12 * GiB);
});

test('available memory cannot exceed the reported container capacity', (t) => {
  t.mock.method(os, 'totalmem', () => 2 * GiB);
  t.mock.method(fs, 'readFileSync', () => 'MemAvailable: 4194304 kB\n');
  assert.equal(system().availableMem, 2 * GiB);
});

for (const meminfo of [null, 'MemFree: 1048576 kB\n', 'MemAvailable: invalid kB\n']) {
  test(`host memory falls back to free RAM for ${meminfo === null ? 'unavailable' : 'incomplete'} meminfo`, (t) => {
    t.mock.method(os, 'freemem', () => GiB);
    t.mock.method(fs, 'readFileSync', () => {
      if (meminfo === null) throw new Error('Not supported');
      return meminfo;
    });
    assert.equal(system().availableMem, GiB);
  });
}

test('zero available memory remains zero', (t) => {
  t.mock.method(fs, 'readFileSync', () => 'MemAvailable: 0 kB\n');
  assert.equal(system().availableMem, 0);
});

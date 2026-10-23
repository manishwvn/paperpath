import assert from 'node:assert/strict';
import { lstat, mkdtemp, mkdir, readFile, readdir, rmdir, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { test } from 'node:test';
import { Store } from '../src/domain.ts';
import { formNames, prepareExport } from '../src/pdf.ts';

test('manifest write failure leaves no cached export and allows a same-key retry', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'paperpath-export-persistence-'));
  const exportsDirectory = join(directory, 'exports');
  await mkdir(exportsDirectory);
  const store = new Store(join(directory, 'paperpath.sqlite'));
  const attemptIds: { failed?: string; retried?: string } = {};
  t.after(async () => {
    store.close();
    const knownExportIds = [...new Set([attemptIds.failed, attemptIds.retried].filter((id): id is string => id !== undefined))];
    assert.ok(knownExportIds.every(id => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)),
      'preserve temporary root when an attempt ID is unexpected');
    const fixtureStat = await lstat(directory);
    assert.ok(fixtureStat.isDirectory() && !fixtureStat.isSymbolicLink(),
      'preserve temporary root when the fixture path is not a real directory');
    const expectedRootEntries = ['exports', 'paperpath.sqlite', 'paperpath.sqlite-shm', 'paperpath.sqlite-wal'];
    const rootEntries = await readdir(directory);
    assert.deepEqual(rootEntries.filter(name => !expectedRootEntries.includes(name)), [],
      'preserve temporary root when it contains an unexpected entry');
    assert.ok(rootEntries.includes('exports') && rootEntries.includes('paperpath.sqlite'),
      'preserve temporary root when required entries are missing');
    const rootStats = new Map(await Promise.all(rootEntries.map(async name => [name, await lstat(join(directory, name))] as const)));
    assert.ok(rootStats.get('exports')?.isDirectory() && !rootStats.get('exports')?.isSymbolicLink(),
      'preserve temporary root when exports is not a real directory');
    for (const name of ['paperpath.sqlite', 'paperpath.sqlite-shm', 'paperpath.sqlite-wal']) {
      const stat = rootStats.get(name);
      if (stat) assert.ok(stat.isFile() && !stat.isSymbolicLink(), `preserve temporary root when ${name} is not a regular file`);
    }

    assert.deepEqual((await readdir(exportsDirectory)).sort(), [...knownExportIds].sort(),
      'preserve temporary root when exports contains an unknown attempt');
    for (const exportId of knownExportIds) {
      const exportDirectory = join(exportsDirectory, exportId);
      const stat = await lstat(exportDirectory);
      assert.ok(stat.isDirectory() && !stat.isSymbolicLink(), 'preserve temporary root when an attempt is not a real directory');
      const expectedNames = [...formNames.map(name => `${name}.pdf`), ...(exportId === attemptIds.retried ? ['manifest.json'] : [])].sort();
      assert.deepEqual((await readdir(exportDirectory)).sort(), expectedNames,
        'preserve temporary root when an attempt contains unexpected files');
      for (const name of expectedNames) {
        const fileStat = await lstat(join(exportDirectory, name));
        assert.ok(fileStat.isFile() && !fileStat.isSymbolicLink(),
          'preserve temporary root when an attempt artifact is not a regular file');
      }
    }

    for (const exportId of knownExportIds) {
      const exportDirectory = join(exportsDirectory, exportId);
      for (const name of formNames.map(form => `${form}.pdf`)) await unlink(join(exportDirectory, name));
      if (exportId === attemptIds.retried) await unlink(join(exportDirectory, 'manifest.json'));
      await rmdir(exportDirectory);
    }
    await rmdir(exportsDirectory);
    const database = join(directory, 'paperpath.sqlite');
    await unlink(database);
    for (const name of ['paperpath.sqlite-wal', 'paperpath.sqlite-shm']) {
      if (rootStats.has(name)) await unlink(join(directory, name));
    }
    assert.deepEqual(await readdir(directory), []);
    await rmdir(directory);
  });
  const owner = store.session();
  const created = store.create(owner, 'export-persistence-create');
  const sourceText = 'Applicant: Nora Patel. Contact: nora@example.org. Availability: Tuesdays. I do not need equipment. I want to help neighbors.';
  const packet = store.propose(owner, created.id, created.revision, 'export-persistence-propose', sourceText, [
    { field: 'name', value: 'Nora Patel', quote: 'Applicant: Nora Patel.' },
    { field: 'email', value: 'nora@example.org', quote: 'nora@example.org' },
    { field: 'availability', value: 'Tuesdays', quote: 'Availability: Tuesdays.' },
    { field: 'equipment', value: false, quote: 'I do not need equipment.' },
    { field: 'motivation', value: 'I want to help neighbors.', quote: 'I want to help neighbors.' },
  ]);
  const key = 'export-persistence-same-key';
  let failedManifestPath: string | undefined;

  await assert.rejects(prepareExport(store, owner, packet, exportsDirectory, key, async path => {
    failedManifestPath = path;
    attemptIds.failed = basename(dirname(path));
    throw new Error('injected manifest write failure');
  }), /injected manifest write failure/);

  assert.equal(store.cachedExport(owner, packet.id, packet.revision, key), undefined);
  assert.ok(failedManifestPath);
  assert.match(attemptIds.failed!, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  assert.deepEqual((await readdir(join(exportsDirectory, failedManifestPath.split('/').at(-2)!))).sort(),
    formNames.map(name => `${name}.pdf`).sort());

  const retried = await prepareExport(store, owner, packet, exportsDirectory, key);
  attemptIds.retried = String(retried.id);
  assert.match(attemptIds.retried, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  assert.deepEqual(store.cachedExport(owner, packet.id, packet.revision, key), retried);
  assert.deepEqual(JSON.parse(await readFile(join(exportsDirectory, String(retried.id), 'manifest.json'), 'utf8')), retried);
  assert.deepEqual(store.exportManifest(owner, packet.id, String(retried.id)), retried);
  const directoriesBeforeReplay = await readdir(exportsDirectory);
  assert.deepEqual(await prepareExport(store, owner, packet, exportsDirectory, key), retried);
  assert.deepEqual(await readdir(exportsDirectory), directoriesBeforeReplay,
    'same-key replay returns the cached manifest without creating another attempt');
});

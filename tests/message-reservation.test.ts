import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rmdir, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { DomainError, Store, type Candidate } from '../src/domain.ts';

let reservationSequence = 0;
const reservationKey = () => `rsv_test_key_${++reservationSequence}`;

const validSource = 'Applicant: Nora Patel. Contact: nora@example.org. Availability: Tuesdays after 4 pm. I do not need equipment.';
const validCandidate: Candidate = { field: 'name', value: 'Nora Patel', quote: 'Applicant: Nora Patel.' };
const completeCandidates: Candidate[] = [
  { field: 'name', value: 'Nora Patel', quote: 'Applicant: Nora Patel.' },
  { field: 'email', value: 'nora@example.org', quote: 'Contact: nora@example.org.' },
  { field: 'availability', value: 'Tuesdays after 4 pm', quote: 'Availability: Tuesdays after 4 pm.' },
  { field: 'equipment', value: false, quote: 'I do not need equipment.' },
];

function expectDomainError(action: () => unknown, code: string): void {
  assert.throws(action, (error: unknown) => error instanceof DomainError && error.code === code);
}

async function cleanupOwnedDirectory(directory: string): Promise<void> {
  const databasePath = join(directory, 'paperpath.sqlite');
  for (const path of [databasePath, `${databasePath}-wal`, `${databasePath}-shm`]) {
    try {
      await unlink(path);
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'code' in error && (error as { code: unknown }).code === 'ENOENT') continue;
      throw error;
    }
  }
  await rmdir(directory);
}

test('legacy database migrates and preserves seeded rows while acquiring reservation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'paperpath-reservation-legacy-'));
  const databasePath = join(directory, 'paperpath.sqlite');
  const stores: Store[] = [];
  const legacyOwner = randomUUID();
  const legacyCaseId = randomUUID();
  const now = new Date().toISOString();
  const legacyPacket = { id: legacyCaseId, revision: 1, createdAt: now, updatedAt: now, confirmedRevision: null, facts: {}, sources: [], audit: [{ revision: 1, action: 'create', at: now, changed: [] as string[] }] };
  const legacyBody = JSON.stringify(legacyPacket);
  const legacyOpKey = 'legacy_op_key_1';
  const legacyOpResult = JSON.stringify(legacyPacket);
  const legacyExportId = 'legacy-export-1';
  const legacyManifest = JSON.stringify({ legacy: true });
  try {
    const raw = new DatabaseSync(databasePath);
    try {
      raw.exec(`
CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY);
INSERT OR IGNORE INTO schema_version VALUES (1);
CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS cases (
  id TEXT PRIMARY KEY, owner TEXT NOT NULL REFERENCES sessions(id),
  revision INTEGER NOT NULL, body TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS operations (
  owner TEXT NOT NULL REFERENCES sessions(id), key TEXT NOT NULL,
  payload_hash TEXT NOT NULL, result TEXT NOT NULL, PRIMARY KEY(owner,key)
);
CREATE TABLE IF NOT EXISTS exports (
  id TEXT PRIMARY KEY, case_id TEXT NOT NULL REFERENCES cases(id),
  revision INTEGER NOT NULL, manifest TEXT NOT NULL
);
`);
      raw.prepare('INSERT INTO sessions VALUES (?,?)').run(legacyOwner, now);
      raw.prepare('INSERT INTO cases VALUES (?,?,?,?)').run(legacyCaseId, legacyOwner, 1, legacyBody);
      raw.prepare('INSERT INTO operations VALUES (?,?,?,?)').run(legacyOwner, legacyOpKey, 'legacy-payload-hash', legacyOpResult);
      raw.prepare('INSERT INTO exports VALUES (?,?,?,?)').run(legacyExportId, legacyCaseId, 1, legacyManifest);
      const before = raw.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='message_reservations'").get();
      assert.equal(before, undefined);
    } finally {
      raw.close();
    }
    const store = new Store(databasePath);
    stores.push(store);
    assert.equal(store.sessionExists(legacyOwner), true);
    assert.deepEqual(store.get(legacyOwner, legacyCaseId), legacyPacket);
    const keptOp = store.db.prepare('SELECT payload_hash, result FROM operations WHERE owner=? AND key=?').get(legacyOwner, legacyOpKey);
    assert.ok(keptOp);
    assert.equal(keptOp.payload_hash, 'legacy-payload-hash');
    assert.equal(keptOp.result, legacyOpResult);
    const keptExport = store.db.prepare('SELECT revision, manifest FROM exports WHERE id=? AND case_id=?').get(legacyExportId, legacyCaseId);
    assert.ok(keptExport);
    assert.equal(keptExport.revision, 1);
    assert.equal(keptExport.manifest, legacyManifest);
    const afterTable = store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='message_reservations'").get();
    assert.ok(afterTable);
    assert.equal(afterTable.name, 'message_reservations');
    const acquired = store.reserveMessage(legacyOwner, legacyCaseId, 1, reservationKey(), 'Legacy reservation text.');
    assert.equal(acquired.state, 'pending');
    if (acquired.state !== 'pending') assert.fail('expected pending');
    assert.equal(acquired.acquired, true);
    if (acquired.acquired !== true) assert.fail('expected acquired');
    assert.ok(typeof acquired.attemptToken === 'string' && acquired.attemptToken.length > 0);
  } finally {
    for (const store of stores) store.close();
    await cleanupOwnedDirectory(directory);
  }
});

test('first reservation acquires and second connection observes pending without token', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'paperpath-reservation-'));
  const databasePath = join(directory, 'paperpath.sqlite');
  const stores: Store[] = [];
  try {
    const firstStore = new Store(databasePath);
    stores.push(firstStore);
    const owner = firstStore.session();
    const created = firstStore.create(owner, reservationKey());
    const key = reservationKey();
    const text = 'Reservation note for Nora Patel.';
    const first = firstStore.reserveMessage(owner, created.id, created.revision, key, text);
    assert.equal(first.state, 'pending');
    if (first.state !== 'pending') assert.fail('expected pending');
    assert.equal(first.acquired, true);
    if (first.acquired !== true) assert.fail('expected acquired');
    assert.ok(typeof first.attemptToken === 'string' && first.attemptToken.length > 0);
    const secondStore = new Store(databasePath);
    stores.push(secondStore);
    const second = secondStore.reserveMessage(owner, created.id, created.revision, key, text);
    assert.equal(second.state, 'pending');
    if (second.state !== 'pending') assert.fail('expected pending');
    assert.equal(second.acquired, false);
    assert.ok(!('attemptToken' in second));
  } finally {
    for (const store of stores) store.close();
    await cleanupOwnedDirectory(directory);
  }
});

test('reopened database keeps pending reservation unacquired without replacement token', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'paperpath-reservation-reopen-'));
  const databasePath = join(directory, 'paperpath.sqlite');
  const stores: Store[] = [];
  try {
    const firstStore = new Store(databasePath);
    stores.push(firstStore);
    const owner = firstStore.session();
    const created = firstStore.create(owner, reservationKey());
    const key = reservationKey();
    const text = 'Reservation survives reopen.';
    const first = firstStore.reserveMessage(owner, created.id, created.revision, key, text);
    assert.equal(first.state, 'pending');
    if (first.state !== 'pending') assert.fail('expected pending');
    assert.equal(first.acquired, true);
    if (first.acquired !== true) assert.fail('expected acquired');
    assert.ok(first.attemptToken.length > 0);
    firstStore.close();
    stores.splice(stores.indexOf(firstStore), 1);
    const secondStore = new Store(databasePath);
    stores.push(secondStore);
    const second = secondStore.reserveMessage(owner, created.id, created.revision, key, text);
    assert.equal(second.state, 'pending');
    if (second.state !== 'pending') assert.fail('expected pending');
    assert.equal(second.acquired, false);
    assert.ok(!('attemptToken' in second));
  } finally {
    for (const store of stores) store.close();
    await cleanupOwnedDirectory(directory);
  }
});

test('changed text case revision conflicts but same key under different owner acquires', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'paperpath-reservation-'));
  const databasePath = join(directory, 'paperpath.sqlite');
  const stores: Store[] = [];
  try {
    const store = new Store(databasePath);
    stores.push(store);
    const owner = store.session();
    const firstCase = store.create(owner, reservationKey());
    const secondCase = store.create(owner, reservationKey());
    const key = reservationKey();
    const text = 'Original reservation text for Nora Patel.';
    const first = store.reserveMessage(owner, firstCase.id, firstCase.revision, key, text);
    assert.equal(first.state, 'pending');
    if (first.state !== 'pending') assert.fail('expected pending');
    assert.equal(first.acquired, true);
    expectDomainError(() => store.reserveMessage(owner, firstCase.id, firstCase.revision, key, `${text} extra`), 'IDEMPOTENCY_CONFLICT');
    expectDomainError(() => store.reserveMessage(owner, secondCase.id, secondCase.revision, key, text), 'IDEMPOTENCY_CONFLICT');
    expectDomainError(() => store.reserveMessage(owner, firstCase.id, firstCase.revision + 1, key, text), 'IDEMPOTENCY_CONFLICT');
    const otherOwner = store.session();
    const otherCase = store.create(otherOwner, reservationKey());
    const other = store.reserveMessage(otherOwner, otherCase.id, otherCase.revision, key, text);
    assert.equal(other.state, 'pending');
    if (other.state !== 'pending') assert.fail('expected pending');
    assert.equal(other.acquired, true);
    if (other.acquired !== true) assert.fail('expected acquired');
    assert.ok(other.attemptToken.length > 0);
  } finally {
    for (const store of stores) store.close();
    await cleanupOwnedDirectory(directory);
  }
});

test('completed operation replay returns current corrected case before revision check', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'paperpath-reservation-'));
  const databasePath = join(directory, 'paperpath.sqlite');
  const stores: Store[] = [];
  try {
    const store = new Store(databasePath);
    stores.push(store);
    const owner = store.session();
    const created = store.create(owner, reservationKey());
    const proposeKey = reservationKey();
    const proposed = store.propose(owner, created.id, created.revision, proposeKey, validSource, [validCandidate]);
    const corrected = store.correct(owner, created.id, proposed.revision, reservationKey(), 'name', 'Nora Grey');
    const replayed = store.reserveMessage(owner, created.id, created.revision, proposeKey, validSource);
    assert.equal(replayed.state, 'completed');
    if (replayed.state !== 'completed') assert.fail('expected completed');
    assert.deepEqual(replayed.packet, corrected);
    assert.deepEqual(replayed.packet, store.get(owner, created.id));
    assert.equal(replayed.packet.revision, corrected.revision);
  } finally {
    for (const store of stores) store.close();
    await cleanupOwnedDirectory(directory);
  }
});

test('reserved key blocks shared operation namespace but distinct key succeeds', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'paperpath-reservation-'));
  const databasePath = join(directory, 'paperpath.sqlite');
  const stores: Store[] = [];
  try {
    const store = new Store(databasePath);
    stores.push(store);
    const owner = store.session();
    const created = store.create(owner, reservationKey());
    const completed = store.propose(owner, created.id, created.revision, reservationKey(), validSource, completeCandidates);
    const reservedKey = reservationKey();
    const reserved = store.reserveMessage(owner, created.id, completed.revision, reservedKey, 'Follow-up reservation for Nora Patel.');
    assert.equal(reserved.state, 'pending');
    if (reserved.state !== 'pending') assert.fail('expected pending');
    assert.equal(reserved.acquired, true);
    const before = store.get(owner, created.id);
    expectDomainError(() => store.create(owner, reservedKey), 'IDEMPOTENCY_CONFLICT');
    expectDomainError(() => store.propose(owner, created.id, completed.revision, reservedKey, validSource, [validCandidate]), 'IDEMPOTENCY_CONFLICT');
    expectDomainError(() => store.correct(owner, created.id, completed.revision, reservedKey, 'name', 'Nora Grey'), 'IDEMPOTENCY_CONFLICT');
    expectDomainError(() => store.confirm(owner, created.id, completed.revision, reservedKey, true), 'IDEMPOTENCY_CONFLICT');
    expectDomainError(() => store.saveExport(owner, created.id, completed.revision, 'blocked-export', { ok: true }, reservedKey), 'IDEMPOTENCY_CONFLICT');
    assert.deepEqual(store.get(owner, created.id), before);
    const after = store.correct(owner, created.id, completed.revision, reservationKey(), 'name', 'Nora Grey');
    assert.equal(after.revision, before.revision + 1);
  } finally {
    for (const store of stores) store.close();
    await cleanupOwnedDirectory(directory);
  }
});

test('completed non-case export values conflict with reservation requests', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'paperpath-reservation-'));
  const databasePath = join(directory, 'paperpath.sqlite');
  const stores: Store[] = [];
  try {
    const store = new Store(databasePath);
    stores.push(store);
    const owner = store.session();
    const created = store.create(owner, reservationKey());
    const proposed = store.propose(owner, created.id, created.revision, reservationKey(), validSource, completeCandidates);
    const confirmed = store.confirm(owner, created.id, proposed.revision, reservationKey(), true);
    const malformedAudit = { id: created.id, revision: confirmed.revision + 1, audit: 1, sources: [{ text: 'Reservation collision.' }] };
    const malformedSources = { id: created.id, revision: confirmed.revision + 1, audit: [{ action: 'propose' }], sources: 1 };
    const manifests: unknown[] = [null, false, 7, 'not-a-case', [], malformedAudit, malformedSources];
    for (const [index, manifest] of manifests.entries()) {
      const key = reservationKey();
      store.saveExport(owner, created.id, confirmed.revision, `non-case-export-${index}`, manifest, key);
      expectDomainError(() => store.reserveMessage(owner, created.id, confirmed.revision, key, `Reservation collision ${index}.`), 'IDEMPOTENCY_CONFLICT');
      const reservation = store.db.prepare('SELECT 1 FROM message_reservations WHERE owner=? AND key=?').get(owner, key);
      assert.equal(reservation, undefined);
      assert.deepEqual(store.get(owner, created.id), confirmed);
    }
  } finally {
    for (const store of stores) store.close();
    await cleanupOwnedDirectory(directory);
  }
});

test('completed non-message operation key conflicts with reservation request', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'paperpath-reservation-'));
  const databasePath = join(directory, 'paperpath.sqlite');
  const stores: Store[] = [];
  try {
    const store = new Store(databasePath);
    stores.push(store);
    const owner = store.session();
    const created = store.create(owner, reservationKey());
    const proposed = store.propose(owner, created.id, created.revision, reservationKey(), validSource, [validCandidate]);
    const key = reservationKey();
    const corrected = store.correct(owner, created.id, proposed.revision, key, 'name', 'Nora Grey');
    expectDomainError(() => store.reserveMessage(owner, created.id, proposed.revision, key, 'Nora Grey'), 'IDEMPOTENCY_CONFLICT');
    assert.deepEqual(store.get(owner, created.id), corrected);
    const reservation = store.db.prepare('SELECT 1 FROM message_reservations WHERE owner=? AND key=?').get(owner, key);
    assert.equal(reservation, undefined);
  } finally {
    for (const store of stores) store.close();
    await cleanupOwnedDirectory(directory);
  }
});

test('reservation alone leaves case packet exactly unchanged', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'paperpath-reservation-'));
  const databasePath = join(directory, 'paperpath.sqlite');
  const stores: Store[] = [];
  try {
    const store = new Store(databasePath);
    stores.push(store);
    const owner = store.session();
    const created = store.create(owner, reservationKey());
    const completed = store.propose(owner, created.id, created.revision, reservationKey(), validSource, completeCandidates);
    const before = store.get(owner, created.id);
    const beforeJson = JSON.stringify(before);
    const reserved = store.reserveMessage(owner, created.id, completed.revision, reservationKey(), 'Unrelated reservation text.');
    assert.equal(reserved.state, 'pending');
    if (reserved.state !== 'pending') assert.fail('expected pending');
    assert.equal(reserved.acquired, true);
    const after = store.get(owner, created.id);
    assert.deepEqual(after, before);
    assert.equal(after.revision, before.revision);
    assert.deepEqual(after.facts, before.facts);
    assert.deepEqual(after.sources, before.sources);
    assert.deepEqual(after.audit, before.audit);
    assert.equal(JSON.stringify(after), beforeJson);
  } finally {
    for (const store of stores) store.close();
    await cleanupOwnedDirectory(directory);
  }
});

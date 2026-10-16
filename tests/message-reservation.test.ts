import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rmdir, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { Worker } from 'node:worker_threads';
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
    assert.equal(secondStore.completeMessage(owner,created.id,created.revision,key,text,first.attemptToken,[]).revision,created.revision+1);
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
    const operationBefore = store.db.prepare('SELECT payload_hash, result FROM operations WHERE owner=? AND key=?').get(owner, proposeKey);
    const caseBefore = store.db.prepare('SELECT body FROM cases WHERE id=? AND owner=?').get(created.id, owner);
    const reservationSql = 'SELECT owner, key, case_id, expected_revision, source_text, fingerprint, attempt_token, created_at FROM message_reservations WHERE owner=? ORDER BY key';
    const reservationsBefore = JSON.stringify(store.db.prepare(reservationSql).all(owner));
    assert.ok(operationBefore);
    assert.ok(caseBefore);
    const corrupted = JSON.parse(String(operationBefore.result)) as { sources: Array<{ sha256: string }> };
    const lastSource = corrupted.sources.at(-1);
    assert.ok(lastSource);
    lastSource.sha256 = 'corrupted-sha256';
    store.db.prepare('UPDATE operations SET result=? WHERE owner=? AND key=?').run(JSON.stringify(corrupted), owner, proposeKey);
    expectDomainError(() => store.reserveMessage(owner, created.id, created.revision, proposeKey, validSource), 'IDEMPOTENCY_CONFLICT');
    const operationAfter = store.db.prepare('SELECT payload_hash FROM operations WHERE owner=? AND key=?').get(owner, proposeKey);
    const caseAfter = store.db.prepare('SELECT body FROM cases WHERE id=? AND owner=?').get(created.id, owner);
    assert.ok(operationAfter);
    assert.ok(caseAfter);
    assert.equal(operationAfter.payload_hash, operationBefore.payload_hash);
    assert.equal(caseAfter.body, caseBefore.body);
    assert.equal(JSON.stringify(store.db.prepare(reservationSql).all(owner)), reservationsBefore);
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

test('owned reservation completes once and replays the current corrected case after reopen', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'paperpath-reservation-complete-'));
  const databasePath = join(directory, 'paperpath.sqlite');
  const stores: Store[] = [];
  try {
    const firstStore = new Store(databasePath);
    stores.push(firstStore);
    const owner = firstStore.session();
    const created = firstStore.create(owner, reservationKey());
    const key = reservationKey();
    const reserved = firstStore.reserveMessage(owner, created.id, created.revision, key, validSource);
    assert.equal(reserved.state, 'pending');
    if (reserved.state !== 'pending') assert.fail('expected pending');
    assert.equal(reserved.acquired, true);
    if (reserved.acquired !== true) assert.fail('expected acquired');
    const attemptToken = reserved.attemptToken;
    const completed = firstStore.completeMessage(owner, created.id, created.revision, key, validSource, attemptToken, completeCandidates);
    assert.equal(completed.revision, created.revision + 1);
    assert.equal(completed.sources.length, 1);
    const operation = firstStore.db.prepare('SELECT payload_hash,result FROM operations WHERE owner=? AND key=?').get(owner, key);
    const reservation = firstStore.db.prepare('SELECT fingerprint FROM message_reservations WHERE owner=? AND key=?').get(owner, key);
    assert.ok(operation);
    assert.equal(reservation, undefined);
    const expectedPayloadHash = createHash('sha256').update(JSON.stringify({
      id:created.id,revision:created.revision,action:'propose',
      input:{sourceText:validSource,candidates:completeCandidates},
    })).digest('hex');
    const reservationFingerprint = createHash('sha256').update(JSON.stringify({
      id:created.id,revision:created.revision,text:validSource,
    })).digest('hex');
    const sourceHash = createHash('sha256').update(validSource).digest('hex');
    assert.equal(operation.payload_hash, expectedPayloadHash);
    assert.notEqual(operation.payload_hash, reservationFingerprint);
    assert.notEqual(operation.payload_hash, sourceHash);
    const storedResult = JSON.parse(String(operation.result)) as typeof completed;
    assert.equal(storedResult.sources[0]?.sha256, sourceHash);
    firstStore.close();
    stores.splice(stores.indexOf(firstStore), 1);

    const reopened = new Store(databasePath);
    stores.push(reopened);
    const corrected = reopened.correct(owner, created.id, completed.revision, reservationKey(), 'name', 'Nora Grey');
    const replay = reopened.reserveMessage(owner, created.id, created.revision, key, validSource);
    assert.equal(replay.state, 'completed');
    if (replay.state !== 'completed') assert.fail('expected completed');
    assert.deepEqual(replay.packet, corrected);
    expectDomainError(
      () => reopened.completeMessage(owner, created.id, created.revision, key, validSource, attemptToken, completeCandidates),
      'IDEMPOTENCY_CONFLICT',
    );
    const operationCount = reopened.db.prepare('SELECT COUNT(*) AS count FROM operations WHERE owner=? AND key=?').get(owner, key);
    assert.equal(Number(operationCount?.count), 1);
    assert.equal(reopened.get(owner, created.id).sources.length, 2);
  } finally {
    for (const store of stores) store.close();
    await cleanupOwnedDirectory(directory);
  }
});

test('completion rejects mismatched ownership and bindings without changing durable state', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'paperpath-reservation-bindings-'));
  const databasePath = join(directory, 'paperpath.sqlite');
  const stores: Store[] = [];
  try {
    const store = new Store(databasePath);
    stores.push(store);
    const owner = store.session();
    const created = store.create(owner, reservationKey());
    const otherCase = store.create(owner, reservationKey());
    const key = reservationKey();
    const reserved = store.reserveMessage(owner, created.id, created.revision, key, validSource);
    assert.equal(reserved.state, 'pending');
    if (reserved.state !== 'pending') assert.fail('expected pending');
    assert.equal(reserved.acquired, true);
    if (reserved.acquired !== true) assert.fail('expected acquired');
    const otherOwner = store.session();
    const observer = new Store(databasePath);
    stores.push(observer);
    const snapshot = () => JSON.stringify({
      cases:observer.db.prepare('SELECT id,owner,revision,body FROM cases ORDER BY id').all(),
      operations:observer.db.prepare('SELECT owner,key,payload_hash,result FROM operations ORDER BY owner,key').all(),
      reservations:observer.db.prepare('SELECT owner,key,case_id,expected_revision,source_text,fingerprint,attempt_token,created_at FROM message_reservations ORDER BY owner,key').all(),
    });
    const unchangedConflict = (attempt: () => unknown) => {
      const before = snapshot();
      expectDomainError(attempt, 'IDEMPOTENCY_CONFLICT');
      assert.equal(snapshot(), before);
    };
    unchangedConflict(() => store.completeMessage(otherOwner, created.id, created.revision, key, validSource, reserved.attemptToken, completeCandidates));
    unchangedConflict(() => store.completeMessage(owner, created.id, created.revision, key, validSource, 'wrong-attempt-token', completeCandidates));
    unchangedConflict(() => store.completeMessage(owner, otherCase.id, created.revision, key, validSource, reserved.attemptToken, completeCandidates));
    unchangedConflict(() => store.completeMessage(owner, created.id, created.revision + 1, key, validSource, reserved.attemptToken, completeCandidates));
    unchangedConflict(() => store.completeMessage(owner, created.id, created.revision, key, validSource + ' changed', reserved.attemptToken, completeCandidates));

    const expectedFingerprint = createHash('sha256').update(JSON.stringify({
      id:created.id,revision:created.revision,text:validSource,
    })).digest('hex');
    store.db.prepare('UPDATE message_reservations SET fingerprint=? WHERE owner=? AND key=?')
      .run('tampered-fingerprint', owner, key);
    unchangedConflict(() => store.completeMessage(owner, created.id, created.revision, key, validSource, reserved.attemptToken, completeCandidates));
    store.db.prepare('UPDATE message_reservations SET fingerprint=? WHERE owner=? AND key=?')
      .run(expectedFingerprint, owner, key);
    const completed = store.completeMessage(owner, created.id, created.revision, key, validSource, reserved.attemptToken, completeCandidates);
    assert.equal(completed.sources.length, 1);
    const operationCount = observer.db.prepare('SELECT COUNT(*) AS count FROM operations WHERE owner=? AND key=?').get(owner, key);
    assert.equal(Number(operationCount?.count), 1);
    assert.equal(observer.get(owner, created.id).sources.length, 1);
  } finally {
    for (const store of stores) store.close();
    await cleanupOwnedDirectory(directory);
  }
});

test('invalid evidence keeps the reservation and permits completion with the same token', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'paperpath-reservation-evidence-'));
  const databasePath = join(directory, 'paperpath.sqlite');
  const stores: Store[] = [];
  try {
    const store = new Store(databasePath);
    stores.push(store);
    const owner = store.session();
    const created = store.create(owner, reservationKey());
    const key = reservationKey();
    const reserved = store.reserveMessage(owner, created.id, created.revision, key, validSource);
    assert.equal(reserved.state, 'pending');
    if (reserved.state !== 'pending') assert.fail('expected pending');
    assert.equal(reserved.acquired, true);
    if (reserved.acquired !== true) assert.fail('expected acquired');
    const observer = new Store(databasePath);
    stores.push(observer);
    const snapshot = () => JSON.stringify({
      case:observer.db.prepare('SELECT revision,body FROM cases WHERE id=? AND owner=?').get(created.id, owner),
      operation:observer.db.prepare('SELECT payload_hash,result FROM operations WHERE owner=? AND key=?').get(owner, key),
      reservation:observer.db.prepare('SELECT owner,key,case_id,expected_revision,source_text,fingerprint,attempt_token FROM message_reservations WHERE owner=? AND key=?').get(owner, key),
    });
    const before = snapshot();
    expectDomainError(
      () => store.completeMessage(owner, created.id, created.revision, key, validSource, reserved.attemptToken, [
        { field:'name',value:'Nora Patel',quote:'This quote is absent from the source.' },
      ]),
      'UNSUPPORTED_EVIDENCE',
    );
    assert.equal(snapshot(), before);
    const completed = store.completeMessage(owner, created.id, created.revision, key, validSource, reserved.attemptToken, completeCandidates);
    assert.equal(completed.revision, created.revision + 1);
    assert.equal(completed.sources.length, 1);
    assert.equal(snapshot().includes('"reservation":undefined'), false);
    const operationCount = observer.db.prepare('SELECT COUNT(*) AS count FROM operations WHERE owner=? AND key=?').get(owner, key);
    assert.equal(Number(operationCount?.count), 1);
  } finally {
    for (const store of stores) store.close();
    await cleanupOwnedDirectory(directory);
  }
});


test('stale owned case revision leaves the reservation unchanged', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'paperpath-reservation-stale-'));
  const databasePath = join(directory, 'paperpath.sqlite');
  const stores: Store[] = [];
  try {
    const store = new Store(databasePath);
    stores.push(store);
    const owner = store.session();
    const created = store.create(owner, reservationKey());
    const key = reservationKey();
    const reserved = store.reserveMessage(owner, created.id, created.revision, key, validSource);
    assert.equal(reserved.state, 'pending');
    if (reserved.state !== 'pending') assert.fail('expected pending');
    assert.equal(reserved.acquired, true);
    if (reserved.acquired !== true) assert.fail('expected acquired');
    const observer = new Store(databasePath);
    stores.push(observer);
    store.correct(owner, created.id, created.revision, reservationKey(), 'name', 'Nora Grey');
    const snapshot = () => JSON.stringify({
      cases:observer.db.prepare('SELECT id,owner,revision,body FROM cases ORDER BY id').all(),
      operations:observer.db.prepare('SELECT owner,key,payload_hash,result FROM operations ORDER BY owner,key').all(),
      reservations:observer.db.prepare('SELECT owner,key,case_id,expected_revision,source_text,fingerprint,attempt_token FROM message_reservations ORDER BY owner,key').all(),
    });
    const before = snapshot();
    expectDomainError(
      () => store.completeMessage(owner, created.id, created.revision, key, validSource, reserved.attemptToken, completeCandidates),
      'STALE_REVISION',
    );
    assert.equal(snapshot(), before);
  } finally {
    for (const store of stores) store.close();
    await cleanupOwnedDirectory(directory);
  }
});

test('reservation deletion failure rolls back completion and retains the token reservation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'paperpath-reservation-delete-abort-'));
  const databasePath = join(directory, 'paperpath.sqlite');
  const stores: Store[] = [];
  try {
    const store = new Store(databasePath);
    stores.push(store);
    const owner = store.session();
    const created = store.create(owner, reservationKey());
    const key = reservationKey();
    const reserved = store.reserveMessage(owner, created.id, created.revision, key, validSource);
    assert.equal(reserved.state, 'pending');
    if (reserved.state !== 'pending') assert.fail('expected pending');
    assert.equal(reserved.acquired, true);
    if (reserved.acquired !== true) assert.fail('expected acquired');
    const observer = new Store(databasePath);
    stores.push(observer);
    store.db.exec(
      "CREATE TRIGGER reservation_delete_abort_test BEFORE DELETE ON message_reservations BEGIN SELECT RAISE(ABORT, 'test reservation delete blocked'); END;",
    );
    const snapshot = () => JSON.stringify({
      case:observer.db.prepare('SELECT revision,body FROM cases WHERE id=? AND owner=?').get(created.id, owner),
      operation:observer.db.prepare('SELECT payload_hash,result FROM operations WHERE owner=? AND key=?').get(owner, key),
      reservation:observer.db.prepare('SELECT owner,key,case_id,expected_revision,source_text,fingerprint,attempt_token FROM message_reservations WHERE owner=? AND key=?').get(owner, key),
    });
    const before = snapshot();
    assert.throws(
      () => store.completeMessage(owner, created.id, created.revision, key, validSource, reserved.attemptToken, completeCandidates),
      /test reservation delete blocked/,
    );
    assert.equal(snapshot(), before);
    store.db.exec('DROP TRIGGER reservation_delete_abort_test');
    const completed = store.completeMessage(owner, created.id, created.revision, key, validSource, reserved.attemptToken, completeCandidates);
    assert.equal(completed.revision, created.revision + 1);
    assert.equal(completed.sources.length, 1);
    const operationCount = observer.db.prepare('SELECT COUNT(*) AS count FROM operations WHERE owner=? AND key=?').get(owner, key);
    assert.equal(Number(operationCount?.count), 1);
    const remainingReservation = observer.db.prepare('SELECT 1 FROM message_reservations WHERE owner=? AND key=?').get(owner, key);
    assert.equal(remainingReservation, undefined);
  } finally {
    for (const store of stores) store.close();
    await cleanupOwnedDirectory(directory);
  }
});


function reservationDurableSnapshot(s: Store): string {
return JSON.stringify({cases:s.db.prepare('SELECT id,owner,revision,body FROM cases ORDER BY id').all(),
operations:s.db.prepare('SELECT owner,key,payload_hash,result FROM operations ORDER BY owner,key').all(),
reservations:s.db.prepare('SELECT owner,key,case_id,expected_revision,source_text,fingerprint,attempt_token,created_at FROM message_reservations ORDER BY owner,key').all()});
}
async function reservationFixture() {
const directory=await mkdtemp(join(tmpdir(),'paperpath-reservation-release-')), databasePath=join(directory,'paperpath.sqlite'), stores:Store[]=[];
const store=new Store(databasePath); stores.push(store);
const owner=store.session(), packet=store.create(owner,reservationKey()), key=reservationKey(), text=validSource;
const acquired=store.reserveMessage(owner,packet.id,packet.revision,key,text);
if(acquired.state!=='pending'||acquired.acquired!==true) assert.fail('expected acquired');
return {directory,databasePath,stores,store,owner,packet,key,text,token:acquired.attemptToken};
}
function observeReservation(f: Awaited<ReturnType<typeof reservationFixture>>): Store {
const s=new Store(f.databasePath); f.stores.push(s); return s;
}
async function closeReservationFixture(f: Awaited<ReturnType<typeof reservationFixture>>): Promise<void> {
for(const s of f.stores) s.close();
await cleanupOwnedDirectory(f.directory);
}
function assertUnchanged(s:Store, action:()=>unknown, code='IDEMPOTENCY_CONFLICT'):void {
const before=reservationDurableSnapshot(s); expectDomainError(action,code); assert.equal(reservationDurableSnapshot(s),before);
}
test('release and reacquire require exact binding and fresh token',{timeout:10000},async()=>{
const f=await reservationFixture();
try {
const observer=observeReservation(f);
const release=(x:Partial<{owner:string;id:string;rev:number;key:string;text:string;token:string;outcome:string}>={})=>f.store.releaseMessage(x.owner??f.owner,x.id??f.packet.id,x.rev??f.packet.revision,x.key??f.key,x.text??f.text,x.token??f.token,(x.outcome??'not-started') as 'not-started'|'definitively-failed');
const complete=(token=f.token)=>f.store.completeMessage(f.owner,f.packet.id,f.packet.revision,f.key,f.text,token,completeCandidates);
assertUnchanged(observer,()=>release({outcome:'timeout'}),'INVALID_MESSAGE_OUTCOME');
for(const token of ['', 'bad', 'A'.repeat(32)]) {
assertUnchanged(observer,()=>release({token}));
assertUnchanged(observer,()=>complete(token));
}
const otherOwner=f.store.session(), otherCase=f.store.create(f.owner,reservationKey());
for(const action of [
()=>release({owner:otherOwner}),
()=>release({key:f.key+'x'}),
()=>release({id:otherCase.id}),
()=>release({rev:f.packet.revision+1}),
()=>release({text:f.text+' changed'}),
()=>release({token:'00000000000000000000000000000000'}),
]) assertUnchanged(observer,action);
const fp=String(f.store.db.prepare('SELECT fingerprint FROM message_reservations WHERE owner=? AND key=?').get(f.owner,f.key)?.fingerprint);
f.store.db.prepare('UPDATE message_reservations SET fingerprint=? WHERE owner=? AND key=?').run('bad',f.owner,f.key);
assertUnchanged(observer,()=>release());
f.store.db.prepare('UPDATE message_reservations SET fingerprint=? WHERE owner=? AND key=?').run(fp,f.owner,f.key);
release({outcome:'definitively-failed'});
assert.equal(String(f.store.db.prepare('SELECT attempt_token FROM message_reservations WHERE owner=? AND key=?').get(f.owner,f.key)?.attempt_token),'');
assertUnchanged(observer,()=>complete());
assertUnchanged(observer,()=>complete(''));
const before=reservationDurableSnapshot(observer);
expectDomainError(()=>observer.reserveMessage(f.owner,f.packet.id,f.packet.revision,f.key,f.text+' changed'),'IDEMPOTENCY_CONFLICT');
assert.equal(reservationDurableSnapshot(observer),before);
const gate=new Int32Array(new SharedArrayBuffer(4));
const worker=new Worker("const{parentPort:p,workerData:d}=require('node:worker_threads');(async()=>{const{Store}=await import(d.url);p.postMessage('ready');const g=new Int32Array(d.g);Atomics.wait(g,0,0);const s=new Store(d.path);try{p.postMessage(s.reserveMessage(d.owner,d.id,d.rev,d.key,d.text))}finally{s.close()}})()",{eval:true,workerData:{url:new URL('../src/domain.ts',import.meta.url).href,g:gate.buffer,path:f.databasePath,owner:f.owner,id:f.packet.id,rev:f.packet.revision,key:f.key,text:f.text}});
try {
await new Promise<void>((resolve,reject)=>{worker.once('message',m=>m==='ready'?resolve():reject(new Error('worker failed')));worker.once('error',reject);worker.once('exit',code=>reject(new Error('worker exited '+code)));});
const workerResult=new Promise<ReturnType<Store['reserveMessage']>>((resolve,reject)=>{worker.once('message',m=>resolve(m));worker.once('error',reject);worker.once('exit',code=>reject(new Error('worker exited '+code)));});
Atomics.store(gate,0,1);Atomics.notify(gate,0);
const results=[f.store.reserveMessage(f.owner,f.packet.id,f.packet.revision,f.key,f.text),await workerResult];
const acquired=results.find(r=>r.state==='pending'&&r.acquired);
assert.equal(results.filter(r=>r.state==='pending'&&r.acquired).length,1);
assert.equal(results.filter(r=>r.state==='pending'&&!r.acquired).length,1);
if(!acquired||acquired.state!=='pending'||acquired.acquired!==true) assert.fail('expected one acquisition');
assert.match(acquired.attemptToken,/^[a-f0-9]{32}$/); assert.notEqual(acquired.attemptToken,f.token);
assertUnchanged(observer,()=>release());
assert.equal(complete(acquired.attemptToken).revision,f.packet.revision+1);
} finally { await worker.terminate(); }
} finally { await closeReservationFixture(f); }
});
test('SQL abort rolls back release and reacquire',async()=>{
const f=await reservationFixture();
try {
const observer=observeReservation(f);
f.store.db.exec("CREATE TRIGGER release_abort_test BEFORE UPDATE ON message_reservations BEGIN SELECT RAISE(ABORT, 'release blocked'); END;");
let before=reservationDurableSnapshot(observer);
assert.throws(()=>f.store.releaseMessage(f.owner,f.packet.id,f.packet.revision,f.key,f.text,f.token,'not-started'),/release blocked/);
assert.equal(reservationDurableSnapshot(observer),before);
f.store.db.exec('DROP TRIGGER release_abort_test');
f.store.releaseMessage(f.owner,f.packet.id,f.packet.revision,f.key,f.text,f.token,'not-started');
f.store.db.exec("CREATE TRIGGER reacquire_abort_test BEFORE UPDATE ON message_reservations WHEN OLD.attempt_token='' BEGIN SELECT RAISE(ABORT, 'reacquire blocked'); END;");
before=reservationDurableSnapshot(observer);
assert.throws(()=>f.store.reserveMessage(f.owner,f.packet.id,f.packet.revision,f.key,f.text),/reacquire blocked/);
assert.equal(reservationDurableSnapshot(observer),before);
} finally { await closeReservationFixture(f); }
});

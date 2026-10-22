import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rmdir, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { DomainError, Store, validatePacket, type Candidate, type Field } from '../src/domain.ts';

let idempotencySequence = 0;
const idempotencyKey = () => `domain_test_${++idempotencySequence}`;
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

function expectDomainError(action: () => unknown, code: string): void {
  assert.throws(action, (error: unknown) => error instanceof DomainError && error.code === code);
}

async function removeTestDatabase(directory: string): Promise<void> {
  const databasePath = join(directory, 'paperpath.sqlite');
  for (const path of [databasePath, `${databasePath}-wal`, `${databasePath}-shm`]) {
    try {
      await unlink(path);
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') continue;
      throw error;
    }
  }
  await rmdir(directory);
}

async function withStore(run: (store: Store, owner: string, caseId: string) => void | Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'paperpath-domain-'));
  const store = new Store(join(directory, 'paperpath.sqlite'));
  try {
    const owner = store.session();
    const packet = store.create(owner, idempotencyKey());
    await run(store, owner, packet.id);
  } finally {
    store.close();
    await removeTestDatabase(directory);
  }
}

const completeSource = [
  'Applicant: Nora Patel.',
  'Contact: nora@example.org.',
  'Availability: Tuesdays after 4 pm.',
  'I do not need equipment.',
].join(' ');

const completeCandidates: Candidate[] = [
  { field: 'name', value: 'Nora Patel', quote: 'Applicant: Nora Patel.' },
  { field: 'email', value: 'nora@example.org', quote: 'Contact: nora@example.org.' },
  { field: 'availability', value: 'Tuesdays after 4 pm', quote: 'Availability: Tuesdays after 4 pm.' },
  { field: 'equipment', value: false, quote: 'I do not need equipment.' },
];

function completePacket(store: Store, owner: string, caseId: string) {
  return store.propose(owner, caseId, 1, idempotencyKey(), completeSource, completeCandidates);
}

test('new cases keep every required fact unknown until supported', async () => {
  await withStore((store, owner, caseId) => {
    const packet = store.get(owner, caseId);
    assert.deepEqual(validatePacket(packet), {
      complete: false,
      missing: ['name', 'email', 'availability', 'equipment'],
      conflicts: [],
    });
    assert.deepEqual(packet.facts, {});
    assert.deepEqual(packet.sources, []);
    assert.equal(packet.confirmedRevision, null);
  });
});

test('evidence offsets and hashes bind a fact to an exact source quote', async () => {
  await withStore((store, owner, caseId) => {
    const sourceText = 'Intake note — Applicant: Amira Shah. Please call after lunch.';
    const quote = 'Applicant: Amira Shah.';
    const packet = store.propose(owner, caseId, 1, idempotencyKey(), sourceText, [
      { field: 'name', value: 'Amira Shah', quote },
    ]);
    const source = packet.sources[0];
    const evidence = packet.facts.name?.evidence;

    assert.ok(source);
    assert.ok(evidence);
    assert.equal(source.sha256, sha256(sourceText));
    assert.equal(evidence.sourceId, source.id);
    assert.equal(evidence.start, sourceText.indexOf(quote));
    assert.ok(evidence.start > 0);
    assert.equal(evidence.end, evidence.start + quote.length);
    assert.equal(source.text.slice(evidence.start, evidence.end), quote);
  });
});

test('invented values and quotes absent from the source are rejected without mutation', async () => {
  await withStore((store, owner, caseId) => {
    const packet = store.propose(owner, caseId, 1, idempotencyKey(), 'Applicant: Amira Shah.', [
      { field: 'name', value: 'Amira Shah', quote: 'Applicant: Amira Shah.' },
    ]);
    const before = store.get(owner, caseId);

    expectDomainError(() => store.propose(owner, caseId, packet.revision, idempotencyKey(), 'Applicant: Amira Shah.', [
      { field: 'name', value: 'Jordan Lee', quote: 'Applicant: Amira Shah.' },
    ]), 'UNSUPPORTED_FACT');
    expectDomainError(() => store.propose(owner, caseId, packet.revision, idempotencyKey(), 'Applicant: Amira Shah.', [
      { field: 'motivation', value: 'help neighbors', quote: 'I want to help my neighbors.' },
    ]), 'UNSUPPORTED_EVIDENCE');

    assert.deepEqual(store.get(owner, caseId), before);
  });
});

test('a later conflicting proposal preserves the canonical fact and blocks confirmation and export', async () => {
  await withStore((store, owner, caseId) => {
    const packet = completePacket(store, owner, caseId);
    const conflict = store.propose(owner, caseId, packet.revision, idempotencyKey(), 'Applicant: Nora Grey.', [
      { field: 'name', value: 'Nora Grey', quote: 'Applicant: Nora Grey.' },
    ]);

    assert.equal(conflict.facts.name?.value, 'Nora Patel');
    assert.deepEqual(conflict.facts.name?.conflicts.map(item => item.value), ['Nora Grey']);
    assert.deepEqual(validatePacket(conflict), { complete: false, missing: [], conflicts: ['name'] });
    expectDomainError(() => store.confirm(owner, caseId, conflict.revision, idempotencyKey(), true), 'INCOMPLETE_PACKET');
    expectDomainError(() => store.saveExport(owner, caseId, conflict.revision, 'conflicted-export', {}), 'INCOMPLETE_PACKET');
  });
});

test('an explicit correction transaction replaces the fact and clears its conflict', async () => {
  await withStore((store, owner, caseId) => {
    const packet = completePacket(store, owner, caseId);
    const conflict = store.propose(owner, caseId, packet.revision, idempotencyKey(), 'Availability: Thursdays.', [
      { field: 'availability', value: 'Thursdays', quote: 'Availability: Thursdays.' },
    ]);
    const corrected = store.correct(owner, caseId, conflict.revision, idempotencyKey(), 'availability', 'Thursdays');

    assert.equal(corrected.revision, conflict.revision + 1);
    assert.equal(corrected.facts.availability?.value, 'Thursdays');
    assert.deepEqual(corrected.facts.availability?.conflicts, []);
    assert.equal(corrected.sources.length, 3);
    assert.equal(corrected.sources[1]?.text, 'Availability: Thursdays.');
    assert.equal(corrected.sources[2]?.sha256, sha256('Thursdays'));
    assert.equal(corrected.facts.availability?.evidence.sourceId, corrected.sources[2]?.id);
    assert.deepEqual(corrected.audit.at(-1)?.changed, ['availability'] satisfies Field[]);
    assert.equal(corrected.confirmedRevision, null);
  });
});

test('confirmation requires an explicit trusted UI approval and a complete packet', async () => {
  await withStore((store, owner, caseId) => {
    const packet = completePacket(store, owner, caseId);
    expectDomainError(() => store.confirm(owner, caseId, packet.revision, idempotencyKey(), false), 'USER_CONFIRMATION_REQUIRED');
    assert.equal(store.get(owner, caseId).revision, packet.revision);
    assert.equal(store.get(owner, caseId).confirmedRevision, null);

    const confirmed = store.confirm(owner, caseId, packet.revision, idempotencyKey(), true);
    assert.equal(confirmed.confirmedRevision, confirmed.revision);
    assert.equal(confirmed.audit.at(-1)?.action, 'confirm');
  });
});

test('retrying the same mutation with its idempotency key does not add a revision', async () => {
  await withStore((store, owner, caseId) => {
    const key = idempotencyKey();
    const first = store.propose(owner, caseId, 1, key, 'Applicant: Amira Shah.', [
      { field: 'name', value: 'Amira Shah', quote: 'Applicant: Amira Shah.' },
    ]);
    const retry = store.propose(owner, caseId, 1, key, 'Applicant: Amira Shah.', [
      { field: 'name', value: 'Amira Shah', quote: 'Applicant: Amira Shah.' },
    ]);

    assert.deepEqual(retry, first);
    assert.equal(store.get(owner, caseId).revision, first.revision);
    assert.equal(store.get(owner, caseId).sources.length, 1);
    assert.equal(store.get(owner, caseId).audit.length, 2);
  });
});

test('reusing an idempotency key for different input is rejected', async () => {
  await withStore((store, owner, caseId) => {
    const key = idempotencyKey();
    const packet = store.propose(owner, caseId, 1, key, 'Applicant: Amira Shah.', [
      { field: 'name', value: 'Amira Shah', quote: 'Applicant: Amira Shah.' },
    ]);

    expectDomainError(() => store.propose(owner, caseId, 1, key, 'Applicant: Amira Shah is joining.', [
      { field: 'name', value: 'Amira Shah', quote: 'Applicant: Amira Shah' },
    ]), 'IDEMPOTENCY_CONFLICT');
    assert.deepEqual(store.get(owner, caseId), packet);
  });
});

test('stale edits and cross-owner reads or writes are rejected', async () => {
  await withStore((store, owner, caseId) => {
    const otherOwner = store.session();
    const packet = store.propose(owner, caseId, 1, idempotencyKey(), 'Applicant: Amira Shah.', [
      { field: 'name', value: 'Amira Shah', quote: 'Applicant: Amira Shah.' },
    ]);

    expectDomainError(() => store.correct(owner, caseId, 1, idempotencyKey(), 'name', 'Jordan Lee'), 'STALE_REVISION');
    expectDomainError(() => store.get(otherOwner, caseId), 'CASE_NOT_FOUND');
    expectDomainError(() => store.correct(otherOwner, caseId, packet.revision, idempotencyKey(), 'name', 'Jordan Lee'), 'CASE_NOT_FOUND');
    assert.deepEqual(store.list(otherOwner), []);
    assert.deepEqual(store.get(owner, caseId), packet);
  });
});

test('file-backed cases preserve session, source, facts, and revision after reopen', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'paperpath-domain-reopen-'));
  const databasePath = join(directory, 'paperpath.sqlite');
  let store: Store | undefined;
  try {
    store = new Store(databasePath);
    const owner = store.session();
    const created = store.create(owner, idempotencyKey());
    const packet = store.propose(owner, created.id, created.revision, idempotencyKey(), completeSource, completeCandidates);
    const expected = store.correct(owner, created.id, packet.revision, idempotencyKey(), 'availability', 'Wednesday mornings');
    store.close();

    store = new Store(databasePath);
    assert.equal(store.sessionExists(owner), true);
    assert.deepEqual(store.get(owner, created.id), expected);
    assert.deepEqual(store.list(owner), [expected]);
    assert.equal(store.get(owner, created.id).revision, expected.revision);
    assert.equal(store.get(owner, created.id).sources[0]?.sha256, sha256(completeSource));
  } finally {
    store?.close();
    await removeTestDatabase(directory);
  }
});

test('a saved export is no longer eligible after a correction changes the case revision', async () => {
  await withStore((store, owner, caseId) => {
    const packet = completePacket(store, owner, caseId);
    const confirmed = store.confirm(owner, caseId, packet.revision, idempotencyKey(), true);
    store.saveExport(owner, caseId, confirmed.revision, 'current-packet-export', {
      caseRevision: confirmed.revision,
      sourceHashes: confirmed.sources.map(source => source.sha256),
    });
    const corrected = store.correct(owner, caseId, confirmed.revision, idempotencyKey(), 'availability', 'Wednesday mornings');

    assert.equal(corrected.confirmedRevision, null);
    expectDomainError(() => store.exportManifest(owner, caseId, 'current-packet-export'), 'STALE_EXPORT');
  });
});

test('an explicit equipment negation supports a false proposal', async () => {
  await withStore((store, owner, caseId) => {
    const packet = store.propose(owner, caseId, 1, idempotencyKey(), 'I do not need equipment.', [
      { field: 'equipment', value: false, quote: 'I do not need equipment.' },
    ]);
    assert.equal(packet.facts.equipment?.value, false);
  });
});

test('equipment proposals check every source claim and preserve a quote-ending sentence boundary', async () => {
  await withStore((store, owner, caseId) => {
    const contradictory = 'I need equipment. I do not need equipment.';
    const before = store.get(owner, caseId);
    for (const value of [true, false]) {
      expectDomainError(() => store.propose(owner, caseId, before.revision, idempotencyKey(), contradictory, [
        { field: 'equipment', value, quote: 'I need equipment' },
      ]), 'UNSUPPORTED_FACT');
      assert.deepEqual(store.get(owner, caseId), before);
    }

    const negative = store.propose(owner, caseId, before.revision, idempotencyKey(),
      'I do not need equipment. I hope to volunteer.', [
        { field: 'equipment', value: false, quote: 'I do not need equipment.' },
      ]);
    assert.equal(negative.facts.equipment?.value, false);

    const positive = store.propose(owner, caseId, negative.revision, idempotencyKey(),
      'I need equipment. I hope to volunteer.', [
        { field: 'equipment', value: true, quote: 'I need equipment.' },
      ]);
    assert.equal(positive.facts.equipment?.value, false);
    assert.deepEqual(positive.facts.equipment?.conflicts.map(item => item.value), [true]);
  });
});

test('repeated evidence quotes cannot hide conflicting equipment claims elsewhere in the source', async () => {
  await withStore((store, owner, caseId) => {
    const source = 'I need equipment. I do not need equipment. I need equipment.';
    expectDomainError(() => store.propose(owner, caseId, 1, idempotencyKey(), source, [
      { field: 'equipment', value: true, quote: 'I need equipment' },
    ]), 'UNSUPPORTED_FACT');
    assert.equal(store.get(owner, caseId).revision, 1);
  });
});

test('an uncertain equipment statement does not support a positive proposal', async () => {
  await withStore((store, owner, caseId) => {
    const uncertain = 'I am not sure whether I need equipment.';
    expectDomainError(() => store.propose(owner, caseId, 1, idempotencyKey(), uncertain, [
      { field: 'equipment', value: true, quote: uncertain },
    ]), 'UNSUPPORTED_FACT');
  });
});

test('an uncertain equipment statement does not support a negative proposal', async () => {
  await withStore((store, owner, caseId) => {
    const packet = store.propose(owner, caseId, 1, idempotencyKey(), 'I do not need equipment.', [
      { field: 'equipment', value: false, quote: 'I do not need equipment.' },
    ]);
    const uncertain = 'I am not sure whether I need equipment.';
    expectDomainError(() => store.propose(owner, caseId, packet.revision, idempotencyKey(), uncertain, [
      { field: 'equipment', value: false, quote: uncertain },
    ]), 'UNSUPPORTED_FACT');
  });
});

test('clipped, conditional, uncertain, and contradictory equipment evidence cannot decide a boolean', async () => {
  const ambiguous = [
    { source: 'If I need equipment, I will ask.', quote: 'I need equipment' },
    { source: 'I think I need equipment.', quote: 'I need equipment' },
    { source: 'I need equipment, but I do not need any equipment.', quote: 'I need equipment' },
  ];

  for (const { source, quote } of ambiguous) {
    await withStore((store, owner, caseId) => {
      const before = store.get(owner, caseId);
      for (const value of [true, false]) {
        expectDomainError(() => store.propose(owner, caseId, before.revision, idempotencyKey(), source, [
          { field: 'equipment', value, quote },
        ]), 'UNSUPPORTED_FACT');
        assert.deepEqual(store.get(owner, caseId), before);
      }
    });
  }

  for (const { source, quote } of [
    { source: 'I do not need equipment.', quote: 'need equipment' },
    { source: 'I never need equipment.', quote: 'need equipment' },
  ]) {
    await withStore((store, owner, caseId) => {
      const before = store.get(owner, caseId);
      expectDomainError(() => store.propose(owner, caseId, before.revision, idempotencyKey(), source, [
        { field: 'equipment', value: true, quote },
      ]), 'UNSUPPORTED_FACT');
      assert.deepEqual(store.get(owner, caseId), before);

      const packet = store.propose(owner, caseId, before.revision, idempotencyKey(), source, [
        { field: 'equipment', value: false, quote },
      ]);
      assert.equal(packet.facts.equipment?.value, false);
    });
  }
});

test('equipment ownership and contradictory requests cannot prove no equipment is needed', async () => {
  for (const quote of ["I don't have equipment.", 'I do not own equipment, so I need equipment.',
    'I do not need equipment, but I need equipment.']) {
    await withStore((store, owner, caseId) => {
      expectDomainError(() => store.propose(owner, caseId, 1, idempotencyKey(), quote, [
        { field: 'equipment', value: false, quote },
      ]), 'UNSUPPORTED_FACT');
      assert.equal(store.get(owner, caseId).revision, 1);
    });
  }
  await withStore((store, owner, caseId) => {
    const quote = 'I do not own equipment, so I need equipment.';
    const packet = store.propose(owner, caseId, 1, idempotencyKey(), quote, [
      { field: 'equipment', value: true, quote },
    ]);
    assert.equal(packet.facts.equipment?.value, true);
  });
});

test('committed message recovery returns current state and rejects changed request input', async () => {
  await withStore((store, owner, caseId) => {
    const key = idempotencyKey();
    assert.equal(store.committedMessage(owner, caseId, 1, key, completeSource), undefined);
    const packet = store.propose(owner, caseId, 1, key, completeSource, completeCandidates);
    const corrected = store.correct(owner, caseId, packet.revision, idempotencyKey(), 'availability', 'Wednesday mornings');
    assert.deepEqual(store.committedMessage(owner, caseId, 1, key, completeSource), corrected);
    assert.equal(store.get(owner, caseId).sources.length, 2);
    expectDomainError(() => store.committedMessage(owner, caseId, 1, key, 'Different input'), 'IDEMPOTENCY_CONFLICT');
    expectDomainError(() => store.committedMessage(owner, caseId, 2, key, completeSource), 'IDEMPOTENCY_CONFLICT');
    const operationBefore = store.db.prepare('SELECT payload_hash, result FROM operations WHERE owner=? AND key=?').get(owner, key);
    const caseBefore = store.db.prepare('SELECT body FROM cases WHERE id=? AND owner=?').get(caseId, owner);
    assert.ok(operationBefore);
    assert.ok(caseBefore);
    const corrupted = JSON.parse(String(operationBefore.result)) as { sources: Array<{ sha256: string }> };
    const lastSource = corrupted.sources.at(-1);
    assert.ok(lastSource);
    lastSource.sha256 = 'corrupted-sha256';
    store.db.prepare('UPDATE operations SET result=? WHERE owner=? AND key=?').run(JSON.stringify(corrupted), owner, key);
    expectDomainError(() => store.committedMessage(owner, caseId, 1, key, completeSource), 'IDEMPOTENCY_CONFLICT');
    const operationAfter = store.db.prepare('SELECT payload_hash FROM operations WHERE owner=? AND key=?').get(owner, key);
    const caseAfter = store.db.prepare('SELECT body FROM cases WHERE id=? AND owner=?').get(caseId, owner);
    assert.ok(operationAfter);
    assert.ok(caseAfter);
    assert.equal(operationAfter.payload_hash, operationBefore.payload_hash);
    assert.equal(caseAfter.body, caseBefore.body);
  });
});

test('export idempotency preserves the first manifest and rejects obsolete revisions', async () => {
  await withStore((store, owner, caseId) => {
    const packet = completePacket(store, owner, caseId);
    const key = idempotencyKey();
    const manifest = { revision: packet.revision, artifacts: ['first'] };
    store.saveExport(owner, caseId, packet.revision, 'first-export', manifest, key);
    assert.deepEqual(store.cachedExport(owner, caseId, packet.revision, key), manifest);
    assert.deepEqual(store.saveExport(owner, caseId, packet.revision, 'duplicate-export', { artifacts: ['duplicate'] }, key), manifest);
    expectDomainError(() => store.exportManifest(owner, caseId, 'duplicate-export'), 'EXPORT_NOT_FOUND');
    store.correct(owner, caseId, packet.revision, idempotencyKey(), 'availability', 'Wednesday mornings');
    expectDomainError(() => store.cachedExport(owner, caseId, packet.revision, key), 'STALE_REVISION');
  });
});

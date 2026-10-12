import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';

export const fields = ['name', 'email', 'availability', 'equipment', 'motivation'] as const;
export type Field = typeof fields[number];
export type Value = string | boolean;
export const candidateSchema = z.object({
  field: z.enum(fields), value: z.union([z.string().min(1).max(1000), z.boolean()]),
  quote: z.string().min(1).max(4000),
}).strict();
export type Candidate = z.infer<typeof candidateSchema>;
export type Evidence = { sourceId: string; start: number; end: number; quote: string };
export type Variant = { value: Value; evidence: Evidence };
export type Fact = Variant & { conflicts: Variant[] };
export type Source = { id: string; text: string; sha256: string; createdAt: string };
export type Audit = { revision: number; action: string; at: string; changed: Field[] };
export type Case = {
  id: string; revision: number; createdAt: string; updatedAt: string;
  confirmedRevision: number | null; facts: Partial<Record<Field, Fact>>;
  sources: Source[]; audit: Audit[];
};
export type Validation = { complete: boolean; missing: Field[]; conflicts: Field[] };

export class DomainError extends Error {
  code: string;
  constructor(code: string) { super(code); this.code = code; }
}
const hash = (input: string) => createHash('sha256').update(input).digest('hex');
const required: Field[] = ['name', 'email', 'availability', 'equipment'];

export function validatePacket(packet: Case): Validation {
  const missing = required.filter(field => packet.facts[field] === undefined);
  const conflicts = fields.filter(field => (packet.facts[field]?.conflicts.length ?? 0) > 0);
  return { complete: missing.length === 0 && conflicts.length === 0, missing, conflicts };
}

function validateValue(field: Field, value: Value): void {
  if (field === 'equipment') {
    if (typeof value !== 'boolean') throw new DomainError('INVALID_FACT_TYPE');
  } else {
    if (typeof value !== 'string' || !value.trim() || value.length > (field === 'motivation' ? 1000 : 180)) {
      throw new DomainError('INVALID_FACT_TYPE');
    }
    if (field === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
      throw new DomainError('INVALID_EMAIL');
    }
  }
}

function evidenceFor(source: Source, candidate: Candidate): Evidence {
  validateValue(candidate.field, candidate.value);
  const start = source.text.indexOf(candidate.quote);
  if (start < 0) throw new DomainError('UNSUPPORTED_EVIDENCE');
  if (typeof candidate.value === 'string') {
    if (!candidate.quote.includes(candidate.value)) throw new DomainError('UNSUPPORTED_FACT');
  } else {
    const quote = candidate.quote.trim().toLowerCase().replaceAll('\u2019',"'");
    if (!/\bequipment\b/.test(quote) || /\b(might|maybe|perhaps|probably|could|unsure|uncertain|think|hope)\b|not sure|whether/.test(quote)) {
      throw new DomainError('UNSUPPORTED_FACT');
    }
    const noNeed = /\b(?:(?:do not|don't|dont|no longer)\s+(?:need|require|want)\s+(?:(?:any|some|the)\s+)?equipment|(?:need|require|want)\s+no\s+equipment|no\s+equipment\s+(?:is\s+)?(?:needed|required|requested)|equipment\s+(?:is\s+)?not\s+(?:needed|required|requested))\b/g;
    const negative = noNeed.test(quote);
    noNeed.lastIndex = 0;
    const affirmativeText = quote.replace(noNeed,' ');
    const positive = /\b(?:need|require|want)\s+(?:(?:any|some|the)\s+)?equipment\b|\bequipment\s+(?:is\s+)?(?:needed|required|requested)\b/.test(affirmativeText);
    if (negative && positive || candidate.value && !positive || !candidate.value && !negative) {
      throw new DomainError('UNSUPPORTED_FACT');
    }
  }
  return { sourceId: source.id, start, end: start + candidate.quote.length, quote: candidate.quote };
}

export class Store {
  db: DatabaseSync;
  constructor(path: string) {
    this.db = new DatabaseSync(path, { timeout: 5000, allowExtension: false });
    this.db.exec(`
      PRAGMA journal_mode = WAL;
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
  }
  close() { this.db.close(); }
  session(existing?: string): string {
    if (existing && this.db.prepare('SELECT id FROM sessions WHERE id=?').get(existing)) return existing;
    const id = randomUUID();
    this.db.prepare('INSERT INTO sessions VALUES (?,?)').run(id, new Date().toISOString());
    return id;
  }
  sessionExists(id: string): boolean { return !!this.db.prepare('SELECT id FROM sessions WHERE id=?').get(id); }
  get(owner: string, id: string): Case {
    const row = this.db.prepare('SELECT body FROM cases WHERE id=? AND owner=?').get(id, owner);
    if (!row) throw new DomainError('CASE_NOT_FOUND');
    return JSON.parse(String(row.body)) as Case;
  }
  list(owner: string): Case[] {
    return this.db.prepare('SELECT body FROM cases WHERE owner=? ORDER BY rowid DESC').all(owner)
      .map(row => JSON.parse(String(row.body)) as Case);
  }
  committedMessage(owner: string, id: string, revision: number, key: string, text: string): Case | undefined {
    const prior = this.db.prepare('SELECT result FROM operations WHERE owner=? AND key=?').get(owner,key);
    if (!prior) return undefined;
    const packet = JSON.parse(String(prior.result)) as Case;
    if (packet.id !== id || packet.revision !== revision + 1 || packet.audit?.at(-1)?.action !== 'propose' ||
      packet.sources?.at(-1)?.text !== text) throw new DomainError('IDEMPOTENCY_CONFLICT');
    return this.get(owner,id);
  }
  cachedExport(owner: string, id: string, revision: number, key: string): Record<string,unknown> | undefined {
    const packet = this.get(owner,id);
    if (packet.revision !== revision) throw new DomainError('STALE_REVISION');
    const prior = this.db.prepare('SELECT payload_hash,result FROM operations WHERE owner=? AND key=?').get(owner,key);
    if (!prior) return undefined;
    if (prior.payload_hash !== hash(JSON.stringify({id,revision,action:'export'}))) throw new DomainError('IDEMPOTENCY_CONFLICT');
    return JSON.parse(String(prior.result)) as Record<string,unknown>;
  }
  private transaction<T>(owner: string, key: string, input: unknown, operation: () => T): T {
    if (!this.sessionExists(owner)) throw new DomainError('SESSION_NOT_FOUND');
    if (!/^[a-zA-Z0-9_-]{8,100}$/.test(key)) throw new DomainError('INVALID_IDEMPOTENCY_KEY');
    const payloadHash = hash(JSON.stringify(input));
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const prior = this.db.prepare('SELECT payload_hash,result FROM operations WHERE owner=? AND key=?').get(owner,key);
      if (prior) {
        if (prior.payload_hash !== payloadHash) throw new DomainError('IDEMPOTENCY_CONFLICT');
        this.db.exec('COMMIT');
        return JSON.parse(String(prior.result)) as T;
      }
      const result = operation();
      this.db.prepare('INSERT INTO operations VALUES (?,?,?,?)').run(owner,key,payloadHash,JSON.stringify(result));
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      if (this.db.isTransaction) this.db.exec('ROLLBACK');
      throw error;
    }
  }
  create(owner: string, key: string): Case {
    return this.transaction(owner,key,{ action:'create' },() => {
      const now = new Date().toISOString();
      const packet: Case = { id: randomUUID(), revision: 1, createdAt: now, updatedAt: now,
        confirmedRevision: null, facts: {}, sources: [], audit: [{ revision: 1, action:'create', at:now, changed:[] }] };
      this.db.prepare('INSERT INTO cases VALUES (?,?,?,?)').run(packet.id,owner,1,JSON.stringify(packet));
      return packet;
    });
  }
  private update(owner: string, id: string, revision: number, key: string, input: unknown,
    action: string, change: (packet: Case) => Field[]): Case {
    return this.transaction(owner,key,{ id,revision,action,input },() => {
      const packet = this.get(owner,id);
      if (packet.revision !== revision) throw new DomainError('STALE_REVISION');
      const changed = change(packet);
      packet.revision += 1;
      packet.updatedAt = new Date().toISOString();
      packet.confirmedRevision = action === 'confirm' ? packet.revision : null;
      packet.audit.push({ revision: packet.revision, action, at: packet.updatedAt, changed });
      const saved = this.db.prepare('UPDATE cases SET revision=?,body=? WHERE id=? AND owner=? AND revision=?')
        .run(packet.revision,JSON.stringify(packet),id,owner,revision);
      if (saved.changes !== 1) throw new DomainError('STALE_REVISION');
      return packet;
    });
  }
  propose(owner: string, id: string, revision: number, key: string, sourceText: string, candidates: Candidate[]): Case {
    if (!sourceText.trim() || sourceText.length > 4000 || candidates.length > fields.length) throw new DomainError('INVALID_SOURCE');
    const parsed = z.array(candidateSchema).parse(candidates);
    if (new Set(parsed.map(item => item.field)).size !== parsed.length) throw new DomainError('DUPLICATE_FIELD');
    const source: Source = { id:randomUUID(), text:sourceText, sha256:hash(sourceText), createdAt:new Date().toISOString() };
    const validated = parsed.map(candidate => ({ candidate, evidence: evidenceFor(source,candidate) }));
    return this.update(owner,id,revision,key,{ sourceText,candidates:parsed },'propose',packet => {
      packet.sources.push(source);
      const changed: Field[] = [];
      for (const { candidate, evidence } of validated) {
        const current = packet.facts[candidate.field];
        if (!current) {
          packet.facts[candidate.field] = { value:candidate.value, evidence, conflicts:[] };
          changed.push(candidate.field);
        } else if (current.value !== candidate.value && !current.conflicts.some(item => item.value === candidate.value)) {
          current.conflicts.push({ value:candidate.value, evidence });
          changed.push(candidate.field);
        }
      }
      return changed;
    });
  }
  correct(owner: string, id: string, revision: number, key: string, field: Field, value: Value): Case {
    if (!fields.includes(field)) throw new DomainError('INVALID_FIELD');
    validateValue(field,value);
    return this.update(owner,id,revision,key,{field,value},'correct',packet => {
      const quote = typeof value === 'boolean' ? (value ? 'Yes' : 'No') : value;
      const source: Source = { id:randomUUID(), text:quote, sha256:hash(quote), createdAt:new Date().toISOString() };
      packet.sources.push(source);
      packet.facts[field] = { value,evidence:{sourceId:source.id,start:0,end:quote.length,quote},conflicts:[] };
      return [field];
    });
  }
  confirm(owner: string, id: string, revision: number, key: string, trustedUiApproval: boolean): Case {
    if (!trustedUiApproval) throw new DomainError('USER_CONFIRMATION_REQUIRED');
    return this.update(owner,id,revision,key,{},'confirm',packet => {
      if (!validatePacket(packet).complete) throw new DomainError('INCOMPLETE_PACKET');
      return [];
    });
  }
  saveExport(owner: string, id: string, revision: number, exportId: string, manifest: unknown,
    key = `export-${exportId}`): Record<string,unknown> {
    return this.transaction(owner,key,{id,revision,action:'export'},()=>{
      const packet = this.get(owner,id);
      if (packet.revision !== revision) throw new DomainError('STALE_REVISION');
      if (!validatePacket(packet).complete) throw new DomainError('INCOMPLETE_PACKET');
      this.db.prepare('INSERT INTO exports VALUES (?,?,?,?)').run(exportId,id,revision,JSON.stringify(manifest));
      return manifest as Record<string,unknown>;
    });
  }
  exportManifest(owner: string, id: string, exportId: string): Record<string, unknown> {
    const packet = this.get(owner,id);
    const row = this.db.prepare('SELECT revision,manifest FROM exports WHERE id=? AND case_id=?').get(exportId,id);
    if (!row) throw new DomainError('EXPORT_NOT_FOUND');
    if (row.revision !== packet.revision) throw new DomainError('STALE_EXPORT');
    return JSON.parse(String(row.manifest)) as Record<string,unknown>;
  }
}

import type { Case, Validation, Field, Value, PendingMessage } from '../src/domain.ts';

export class ApiError extends Error {
  code: string;
  status: number;
  constructor(code: string, status = 0, message?: string) {
    super(message ?? code);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
  }
}

export type SessionInfo = { providerReady: boolean; model: string };
export type CasesList = { cases: Case[] };
export type PacketResponse = { packet: Case; validation: Validation; pendingMessages: PendingMessage[] };
export type ExportArtifact = { name: string; [key: string]: unknown };
export type ExportRecord = { id: string; revision: number; status: string; artifacts: ExportArtifact[] };
export type ExportResponse = PacketResponse & { export: ExportRecord };
export type DownloadKind = 'application' | 'availability-equipment';

let csrfToken = '';
const pendingKeys = new Map<string, string>();

function signatureFor(method: string, path: string, body: unknown): string {
  return method + ' ' + path + ' ' + JSON.stringify(body);
}
function keyFor(signature: string): string {
  const existing = pendingKeys.get(signature);
  if (existing) return existing;
  const key = crypto.randomUUID();
  pendingKeys.set(signature, key);
  return key;
}
async function throwForStatus(res: Response): Promise<never> {
  let code = 'http_' + String(res.status);
  try {
    const data = (await res.json()) as { code?: string; error?: string };
    if (typeof data.code === 'string' && data.code) code = data.code;
    else if (typeof data.error === 'string' && data.error) code = data.error;
  } catch {
    // Intentionally ignore error-body decode failures and fall back to HTTP status code.
  }
  throw new ApiError(code, res.status);
}
async function getJson<T>(path: string): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, { credentials: 'same-origin', headers: { Accept: 'application/json' } });
  } catch {
    throw new ApiError('network_error', 0);
  }
  if (!res.ok) await throwForStatus(res);
  try {
    return (await res.json()) as T;
  } catch {
    throw new ApiError('invalid_response', res.status);
  }
}
async function postJson<T>(path: string, payload: Record<string, unknown>): Promise<T> {
  const signature = signatureFor('POST', path, payload);
  const idempotencyKey = keyFor(signature);
  const body = JSON.stringify({ ...payload, idempotencyKey });
  let res: Response;
  try {
    res = await fetch(path, {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'X-PaperPath-CSRF': csrfToken
      },
      body
    });
  } catch {
    throw new ApiError('network_error', 0);
  }
  if (!res.ok) await throwForStatus(res);
  let data: T;
  try {
    data = (await res.json()) as T;
  } catch {
    throw new ApiError('invalid_response', res.status);
  }
  pendingKeys.delete(signature);
  return data;
}
export async function initSession(): Promise<SessionInfo> {
  const data = await getJson<{ csrf: string; providerReady: boolean; model: string }>('/api/session');
  csrfToken = data.csrf;
  return { providerReady: data.providerReady, model: data.model };
}
export function listCases(): Promise<CasesList> {
  return getJson<CasesList>('/api/cases');
}
export function getCase(id: string): Promise<PacketResponse> {
  return getJson<PacketResponse>('/api/cases/' + encodeURIComponent(id));
}
export function createCase(): Promise<PacketResponse> {
  return postJson<PacketResponse>('/api/cases', {});
}
export function sendMessage(caseId: string, expectedRevision: number, text: string): Promise<PacketResponse> {
  const path = '/api/cases/' + encodeURIComponent(caseId) + '/message';
  return postJson<PacketResponse>(path, { expectedRevision, text });
}
export function correctFact(caseId: string, expectedRevision: number, field: Field, value: Value): Promise<PacketResponse> {
  const path = '/api/cases/' + encodeURIComponent(caseId) + '/correct';
  return postJson<PacketResponse>(path, { expectedRevision, field, value });
}
export function confirmFacts(caseId: string, expectedRevision: number): Promise<PacketResponse> {
  const path = '/api/cases/' + encodeURIComponent(caseId) + '/confirm';
  return postJson<PacketResponse>(path, { expectedRevision, iConfirm: true });
}
export function exportPacket(caseId: string, expectedRevision: number): Promise<ExportResponse> {
  const path = '/api/cases/' + encodeURIComponent(caseId) + '/export';
  return postJson<ExportResponse>(path, { expectedRevision });
}
export function getDownloadUrl(caseId: string, exportId: string, kind: DownloadKind): string {
  return '/api/cases/' + encodeURIComponent(caseId) + '/exports/' + encodeURIComponent(exportId) + '/' + encodeURIComponent(kind);
}

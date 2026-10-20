import { initSession, listCases, getCase, createCase, sendMessage, correctFact, confirmFacts, exportPacket, getDownloadUrl, ApiError } from './api.ts';
import type { Case, Validation, Field, Value } from '../src/domain.ts';
import type { PacketResponse } from './api.ts';

const STORE_KEY = 'paperpath.caseId';
const FIELDS: Field[] = ['name', 'email', 'availability', 'equipment', 'motivation'];

let caseId = '';
let revision = 0;
let packet: Case | null = null;
let validation: Validation | null = null;
let providerReady = true;
let busy = false;
let tail: Promise<unknown> = Promise.resolve();
let lastExportId = '';

function $(id: string): HTMLElement | null {
  return document.getElementById(id);
}
function text(el: HTMLElement | null, s: string): void {
  if (el) el.textContent = s;
}
function setStatus(s: string): void {
  text($('status-message'), s);
  const feedback = $('case-feedback');
  if (feedback instanceof HTMLElement) {
    const needsAttention = /failed|unavailable|needs attention/i.test(s);
    feedback.hidden = document.body.dataset.caseActive !== 'false' || !needsAttention;
    feedback.textContent = needsAttention ? s : '';
  }
}
function setError(s: string): void {
  text($('error-message'), s);
  const feedback = $('case-error-feedback');
  if (feedback instanceof HTMLElement) {
    feedback.hidden = document.body.dataset.caseActive !== 'false' || s === '';
    feedback.textContent = s;
  }
}
function loadStored(): string {
  try {
    return localStorage.getItem(STORE_KEY) ?? '';
  } catch {
    return '';
  }
}
function saveStored(id: string): void {
  try {
    if (id) localStorage.setItem(STORE_KEY, id);
    else localStorage.removeItem(STORE_KEY);
  } catch {
    // Intentionally ignore storage errors: case ID persistence is best-effort.
  }
}
function serialize<T>(fn: () => Promise<T>): Promise<T> {
  const run = tail.then(fn, fn);
  tail = run.then(() => undefined, () => undefined);
  return run;
}
function isField(v: string): v is Field {
  return FIELDS.some((f) => f === v);
}
function factValue(field: Field): string | boolean | null {
  const fact = packet ? packet.facts[field] : undefined;
  if (!fact) return null;
  return fact.value;
}
function missingFields(): Field[] {
  if (validation) return validation.missing.slice();
  if (!packet) return FIELDS.slice();
  const out: Field[] = [];
  for (const f of FIELDS) {
    const v = factValue(f);
    if (v === null) out.push(f);
    else if (typeof v === 'string' && v.trim() === '') out.push(f);
  }
  return out;
}
function conflictFields(): Field[] {
  if (validation) return validation.conflicts.slice();
  if (!packet) return [];
  const out: Field[] = [];
  for (const f of FIELDS) {
    const fact = packet.facts[f];
    if (fact && fact.conflicts.length > 0) out.push(f);
  }
  return out;
}
function isComplete(): boolean {
  if (validation) return validation.complete;
  return missingFields().length === 0 && conflictFields().length === 0;
}
function questionFor(f: Field): string {
  if (f === 'equipment') return 'Do you need equipment for volunteering?';
  if (f === 'availability') return 'What is your availability?';
  if (f === 'motivation') return 'What motivates you to volunteer?';
  if (f === 'name') return 'What is your name?';
  if (f === 'email') return 'What is your email?';
  return 'What is your ' + f + '?';
}
function fmt(field: Field, v: string | boolean | null): string {
  if (v === null) return 'Unknown';
  if (typeof v === 'string' && v.trim() === '') return 'Unknown';
  if (field === 'equipment') {
    if (v === true) return 'Yes';
    if (v === false) return 'No';
    return 'Unknown';
  }
  return String(v);
}
function setPreview(id: string, field: Field): void {
  const el = $(id);
  if (!el) return;
  while (el.firstChild) el.removeChild(el.firstChild);
  const v = factValue(field);
  const miss = missingFields().includes(field);
  const conf = conflictFields().includes(field);
  const showUnknown = v === null || (typeof v === 'string' && v.trim() === '') || conf;
  if (showUnknown) {
    const s = document.createElement('span');
    s.setAttribute('class', 'unknown');
    s.textContent = 'Unknown';
    el.appendChild(s);
    if (conf) el.appendChild(document.createTextNode(' (conflicting answers shown as Unknown)'));
  } else {
    el.appendChild(document.createTextNode(fmt(field, v)));
  }
  void miss;
}
function renderSharedAvailability(): void {
  const value = $('shared-value');
  const source = $('shared-source');
  if (!value || !source) return;
  const fact = packet?.facts.availability;
  const conflicting = Boolean(fact && fact.conflicts.length > 0);
  const raw = fact ? fact.value : null;
  const shown = conflicting ? 'Unknown' : fmt('availability', raw);
  value.textContent = shown;
  if (conflicting) {
    source.textContent = 'Conflicting answers; review the evidence below.';
    return;
  }
  if (!fact || shown === 'Unknown') {
    source.textContent = 'No supported availability yet.';
    return;
  }
  source.textContent = 'This value appears on both forms.';
}
function clearDownloads(): void {
  lastExportId = '';
  const a1 = $('download-volunteer-document');
  if (a1 instanceof HTMLAnchorElement) {
    a1.setAttribute('href', '#preview-volunteer-application');
    a1.setAttribute('aria-disabled', 'true');
    a1.textContent = 'Download current volunteer application (placeholder)';
  }
  const a2 = $('download-availability-document');
  if (a2 instanceof HTMLAnchorElement) {
    a2.setAttribute('href', '#preview-availability-request');
    a2.setAttribute('aria-disabled', 'true');
    a2.textContent = 'Download current availability request (placeholder)';
  }
}
function uncheckConfirm(): void {
  const c = $('facts-confirm-checkbox');
  if (c instanceof HTMLInputElement) c.checked = false;
}
function onRevisionChanged(): void {
  uncheckConfirm();
  clearDownloads();
}
function renderMessages(): void {
  const list = $('message-list');
  if (!list) return;
  const history = $('message-history');
  const sources = packet ? packet.sources : [];
  if (history) history.hidden = sources.length === 0;
  while (list.firstChild) list.removeChild(list.firstChild);
  if (sources.length === 0) {
    const li = document.createElement('li');
    li.setAttribute('class', 'placeholder');
    li.textContent = 'No messages yet. Your conversation will appear here as a readable list.';
    list.appendChild(li);
    return;
  }
  for (let i = 0; i < sources.length; i++) {
    const s = sources[i];
    const li = document.createElement('li');
    const b = document.createElement('strong');
    b.textContent = 'Source ' + String(i + 1) + ': ';
    li.appendChild(b);
    li.appendChild(document.createTextNode(s.text));
    list.appendChild(li);
  }
}
function renderEvidence(): void {
  const list = $('evidence-list');
  if (!list) return;
  while (list.firstChild) list.removeChild(list.firstChild);
  const miss = missingFields();
  const conf = conflictFields();
  const need: Field[] = [...new Set([...miss, ...conf])];
  const fieldNames: Record<Field, string> = {
    name: 'Name', email: 'Email', availability: 'Availability',
    equipment: 'Equipment', motivation: 'Motivation'
  };
  for (const field of FIELDS) {
    const fact = packet?.facts[field];
    const conflicting = Boolean(fact && fact.conflicts.length > 0);
    const missing = miss.includes(field);
    const currentValue = fact ? fmt(field, fact.value) : 'Unknown';
    const status = conflicting
      ? 'Unknown — conflicting answers'
      : missing
        ? 'Unknown — missing or incomplete'
        : fact
          ? currentValue
          : 'Unknown — no supporting answer';
    const variants = fact
      ? [
          { label: 'Recorded value', value: fact.value, evidence: fact.evidence },
          ...fact.conflicts.map((variant, index) => ({
            label: 'Conflicting answer ' + String(index + 1),
            value: variant.value,
            evidence: variant.evidence
          }))
        ]
      : [];
    const sourceLabels = variants.map(({ evidence }) => {
      const index = packet?.sources.findIndex((item) => item.id === evidence.sourceId) ?? -1;
      return index >= 0 ? 'Source ' + String(index + 1) : 'Source unavailable';
    });
    const sourcesSummary = sourceLabels.length === 0
      ? 'No source'
      : [...new Set(sourceLabels)].join(', ');
    const item = document.createElement('li');
    item.setAttribute('class', 'evidence-item');
    const disclosure = document.createElement('details');
    const summary = document.createElement('summary');
    summary.textContent = fieldNames[field] + ' — ' + status + ' · ' + sourcesSummary;
    disclosure.appendChild(summary);
    if (variants.length === 0) {
      const question = document.createElement('p');
      question.textContent = 'Open question: ' + questionFor(field);
      disclosure.appendChild(question);
    } else {
      const quotes = document.createElement('ul');
      quotes.setAttribute('class', 'evidence-quotes');
      for (const variant of variants) {
        const sourceIndex = packet?.sources.findIndex((source) => source.id === variant.evidence.sourceId) ?? -1;
        const sourceLabel = sourceIndex >= 0 ? 'Source ' + String(sourceIndex + 1) : 'Source unavailable';
        const quote = document.createElement('li');
        const label = document.createElement('strong');
        label.textContent = variant.label + ' (' + fmt(field, variant.value) + ') · ' + sourceLabel + ': ';
        quote.appendChild(label);
        quote.appendChild(document.createTextNode('“' + variant.evidence.quote + '”'));
        quotes.appendChild(quote);
      }
      disclosure.appendChild(quotes);
      if (missing && !conflicting) {
        const question = document.createElement('p');
        question.textContent = 'Open question: ' + questionFor(field);
        disclosure.appendChild(question);
      }
    }
    item.appendChild(disclosure);
    list.appendChild(item);
  }
  const det = $('details-placeholder');
  if (det instanceof HTMLDetailsElement) {
    while (det.firstChild) det.removeChild(det.firstChild);
    const sum = document.createElement('summary');
    sum.textContent = 'How facts are decided';
    det.appendChild(sum);
    const par = document.createElement('p');
    if (need.length === 0) par.textContent = 'All facts have evidence. Status is confirmed once you confirm for practice.';
    else par.textContent = 'Missing or conflicting: ' + need.join(', ') + '. ' + need.map(questionFor).join(' ');
    det.appendChild(par);
  }
}
function renderPacket(): void {
  renderMessages();
  renderEvidence();
  renderSharedAvailability();
  setPreview('volunteer-name', 'name');
  setPreview('volunteer-email', 'email');
  setPreview('volunteer-availability', 'availability');
  setPreview('volunteer-equipment', 'equipment');
  setPreview('volunteer-motivation', 'motivation');
  setPreview('request-name', 'name');
  setPreview('request-availability', 'availability');
  setPreview('request-equipment', 'equipment');
  const st = $('packet-status');
  const confirmed = packet !== null && packet.confirmedRevision !== null && packet.confirmedRevision === packet.revision;
  if (st) st.textContent = confirmed ? 'Confirmed for practice' : 'Draft not yet confirmed for practice';
  updateButtons();
}
function updateButtons(): void {
  const hasCase = caseId !== '';
  const done = isComplete();
  const box = $('facts-confirm-checkbox');
  const checked = box instanceof HTMLInputElement ? box.checked : false;
  const createBtn = $('case-create-button');
  if (createBtn instanceof HTMLButtonElement) createBtn.disabled = busy;
  const msgBtn = $('message-submit');
  if (msgBtn instanceof HTMLButtonElement) msgBtn.disabled = busy || !hasCase;
  const corBtn = $('correction-availability-apply');
  if (corBtn instanceof HTMLButtonElement) corBtn.disabled = busy || !hasCase;
  const conBtn = $('facts-confirm-button');
  if (conBtn instanceof HTMLButtonElement) conBtn.disabled = busy || !hasCase || !done || !checked;
  const expBtn = $('export-button');
  if (expBtn instanceof HTMLButtonElement) expBtn.disabled = busy || !hasCase;
  const resBtn = $('case-resume-button');
  const input = $('case-id-input');
  const inputVal = input instanceof HTMLInputElement ? input.value.trim() : '';
  if (resBtn instanceof HTMLButtonElement) resBtn.disabled = busy || inputVal === '';
}
function setBusy(on: boolean): void {
  busy = on;
  if (on) {
    const ids: string[] = ['message-submit', 'correction-availability-apply', 'facts-confirm-button', 'export-button', 'case-create-button', 'case-resume-button'];
    for (const id of ids) {
      const b = $(id);
      if (b instanceof HTMLButtonElement) b.disabled = true;
    }
    setStatus('Working...');
  } else {
    updateButtons();
  }
}
function applyPacket(res: PacketResponse, revisionChanged: boolean): void {
  packet = res.packet;
  validation = res.validation;
  caseId = packet.id;
  document.body.dataset.caseActive = 'true';
  revision = packet.revision;
  saveStored(caseId);
  const inp = $('case-id-input');
  if (inp instanceof HTMLInputElement) inp.value = caseId;
  if (revisionChanged) onRevisionChanged();
  renderPacket();
}
function revealRecoveryHelp(): void {
  const pending = $('pending-help');
  const correction = $('resolve-section');
  if (pending instanceof HTMLDetailsElement) pending.open = true;
  if (correction instanceof HTMLDetailsElement) correction.open = true;
}
function isRecoveryError(e: unknown): boolean {
  if (!(e instanceof ApiError)) return false;
  const code = e.code.toLowerCase();
  return e.code === 'MESSAGE_PENDING' || code.includes('provider') || code.includes('model') || code.includes('groq') || code.includes('upstream');
}
function friendly(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.code === 'network_error') return 'Network issue. Your text was kept. Please retry.';
    if (e.code === 'STALE_REVISION') return 'This case changed. Refreshed to the current revision. Please review before retrying.';
    if (e.code === 'MESSAGE_PENDING') return 'This message is still pending and may have completed. Your text is still here, and the case is saved. Select “Resume case” to check the latest state; do not resubmit this message.';
    if (e.code === 'UNSUPPORTED_FACT') return 'That fact was not clearly supported by your message. Please restate the detail you want included.';
    if (e.code === 'UNSUPPORTED_EVIDENCE') return 'The supporting words could not be matched to your message. Please restate the detail exactly.';
    if (e.code === 'invalid_response') return 'Response could not be read. Your text was kept. Please retry.';
    const low = e.code.toLowerCase();
    if (low.includes('provider') || low.includes('model') || low.includes('groq') || low.includes('upstream')) return 'Helper service is unavailable. Your text was kept. You can still correct facts manually.';
    return 'Request failed (' + e.code + '). Your text was kept. Please retry.';
  }
  return 'Something went wrong. Your text was kept. Please retry.';
}
async function refreshCase(): Promise<void> {
  const res = await getCase(caseId);
  const changed = res.packet.revision !== revision;
  applyPacket(res, changed);
}
function fieldSelect(): HTMLSelectElement | null {
  const a = $('correction-field-select');
  if (a instanceof HTMLSelectElement) return a;
  const b = $('correction-field');
  if (b instanceof HTMLSelectElement) return b;
  const c = $('correction-field-input');
  if (c instanceof HTMLSelectElement) return c;
  return null;
}
function ensureCorrectionUI(): void {
  const form = $('correction-form');
  const avail = $('correction-availability-input');
  const availInput = avail instanceof HTMLInputElement ? avail : null;
  let sel = fieldSelect();
  if (!sel && form && availInput) {
    const s = document.createElement('select');
    s.setAttribute('id', 'correction-field-select');
    for (const f of FIELDS) {
      const o = document.createElement('option');
      o.setAttribute('value', f);
      o.textContent = f;
      s.appendChild(o);
    }
    form.insertBefore(s, availInput.parentElement ?? availInput);
    sel = s;
  }
  const eqEl = $('correction-equipment-input');
  let eq = eqEl instanceof HTMLSelectElement ? eqEl : null;
  if (!eq && form) {
    const s = document.createElement('select');
    s.setAttribute('id', 'correction-equipment-input');
    const opts: Array<[string, string]> = [['', 'Select equipment need'], ['true', 'Yes equipment needed'], ['false', 'No']];
    for (const pair of opts) {
      const o = document.createElement('option');
      o.setAttribute('value', pair[0]);
      o.textContent = pair[1];
      s.appendChild(o);
    }
    s.hidden = true;
    form.appendChild(s);
    eq = s;
  }
  const sync = (): void => {
    const raw = sel && sel.value ? sel.value : 'availability';
    const f: Field = isField(raw) ? raw : 'availability';
    const label = form ? form.querySelector('label[for=correction-availability-input]') : null;
    if (label) label.textContent = f === 'availability' ? 'Corrected availability' : 'Corrected ' + f;
    if (availInput) {
      const current = factValue(f);
      const hasCurrent = current !== null && !(typeof current === 'string' && current.trim() === '');
      availInput.placeholder = hasCurrent ? 'Current: ' + fmt(f, current) : 'Enter corrected ' + f;
    }
    const btn = $('correction-availability-apply');
    if (btn) btn.textContent = f === 'availability' ? 'Apply shared availability correction' : 'Apply ' + f + ' correction';
    const availWrap = availInput ? (availInput.closest('.field') ?? availInput.parentElement) : null;
    const eqWrap = eq ? (eq.closest('.field') ?? eq.parentElement) : null;
    if (availInput) availInput.hidden = f === 'equipment';
    if (availWrap instanceof HTMLElement && availWrap !== form) availWrap.hidden = f === 'equipment';
    if (eq) eq.hidden = f !== 'equipment';
    if (eqWrap instanceof HTMLElement && eqWrap !== form) eqWrap.hidden = f !== 'equipment';
  };
  if (sel) sel.addEventListener('change', () => {
    sync();
    updateButtons();
  });
  sync();
}
function currentField(): Field {
  const s = fieldSelect();
  const v = s ? s.value : 'availability';
  return isField(v) ? v : 'availability';
}
async function doCreate(): Promise<void> {
  if (busy) return;
  setError('');
  setBusy(true);
  try {
    const res = await createCase();
    applyPacket(res, true);
    setStatus('Practice packet started.');
    const box = $('message-input');
    if (box instanceof HTMLTextAreaElement) box.focus();
  } catch (e) {
    setError(friendly(e));
    setStatus('Create failed. Please retry.');
  } finally {
    setBusy(false);
  }
}
async function doResume(id: string): Promise<void> {
  if (busy || id === '') return;
  setError('');
  setBusy(true);
  try {
    const res = await getCase(id);
    applyPacket(res, true);
    setStatus('Saved case resumed.');
  } catch (e) {
    setError(friendly(e));
    setStatus('Resume failed. Check the case ID and retry.');
  } finally {
    setBusy(false);
  }
}
async function doSend(): Promise<void> {
  if (busy || !caseId) return;
  const box = $('message-input');
  const input = box instanceof HTMLTextAreaElement ? box : null;
  const t = input ? input.value : '';
  if (t.trim() === '') {
    setError('Please enter a message first.');
    if (input) input.focus();
    return;
  }
  setError('');
  setBusy(true);
  await serialize(async () => {
    try {
      const res = await sendMessage(caseId, revision, t);
      const changed = res.packet.revision !== revision;
      applyPacket(res, changed);
      if (input && input.value === t) input.value = '';
      setStatus('Message saved.');
    } catch (e) {
    if (isRecoveryError(e)) revealRecoveryHelp();
      setStatus('Message request needs attention. Review the error for next steps.');
      if (e instanceof ApiError && e.code === 'STALE_REVISION') {
        try {
          await refreshCase();
        } catch {
          // Intentionally ignore refresh errors: STALE_REVISION message already prompts review.
        }
        setError(friendly(e));
      } else setError(friendly(e));
    } finally {
      setBusy(false);
    }
  });
}
async function doCorrect(): Promise<void> {
  if (busy || !caseId) return;
  const field = currentField();
  let value: Value;
  const avail = $('correction-availability-input');
  const availInput = avail instanceof HTMLInputElement ? avail : null;
  const eqEl = $('correction-equipment-input');
  const eq = eqEl instanceof HTMLSelectElement ? eqEl : null;
  if (field === 'equipment') {
    const v = eq ? eq.value : '';
    if (v === 'true') value = true;
    else if (v === 'false') value = false;
    else {
      setError('Please choose an equipment answer.');
      if (eq) eq.focus();
      return;
    }
  } else {
    const raw = availInput ? availInput.value : '';
    if (raw.trim() === '') {
      setError('Please enter a corrected value.');
      if (availInput) availInput.focus();
      return;
    }
    value = raw;
  }
  setError('');
  setBusy(true);
  await serialize(async () => {
    try {
      const res = await correctFact(caseId, revision, field, value);
      const changed = res.packet.revision !== revision;
      applyPacket(res, changed);
      setStatus('Correction saved.');
    } catch (e) {
      setStatus('Correction request needs attention. Review the error for next steps.');
      if (e instanceof ApiError && e.code === 'STALE_REVISION') {
        try {
          await refreshCase();
        } catch {
          // Intentionally ignore refresh errors: STALE_REVISION message already prompts review.
        }
        setError(friendly(e));
      } else setError(friendly(e));
    } finally {
      setBusy(false);
    }
  });
}
async function doConfirm(): Promise<void> {
  if (busy || !caseId) return;
  const box = $('facts-confirm-checkbox');
  const input = box instanceof HTMLInputElement ? box : null;
  if (!input || !input.checked) {
    setError('Please check the confirmation box first.');
    if (input) input.focus();
    return;
  }
  if (!isComplete()) {
    setError('Facts are not complete. Unknown items remain.');
    return;
  }
  setError('');
  setBusy(true);
  await serialize(async () => {
    try {
      const res = await confirmFacts(caseId, revision);
      const changed = res.packet.revision !== revision;
      applyPacket(res, changed);
      setStatus('Confirmed for practice.');
    } catch (e) {
      setStatus('Confirmation request needs attention. Review the error for next steps.');
      if (e instanceof ApiError && e.code === 'STALE_REVISION') {
        try {
          await refreshCase();
        } catch {
          // Intentionally ignore refresh errors: STALE_REVISION message already prompts review.
        }
        setError(friendly(e));
      } else setError(friendly(e));
    } finally {
      setBusy(false);
    }
  });
}
async function doExport(): Promise<void> {
  if (busy || !caseId) return;
  setError('');
  setBusy(true);
  await serialize(async () => {
    try {
      const res = await exportPacket(caseId, revision);
      const changed = res.packet.revision !== revision;
      applyPacket(res, changed);
      const rec = res.export;
      if (rec.revision === revision && packet && rec.revision === packet.revision) {
        lastExportId = rec.id;
        const status = rec.status;
        const a1 = $('download-volunteer-document');
        if (a1 instanceof HTMLAnchorElement) {
          a1.setAttribute('href', getDownloadUrl(caseId, lastExportId, 'application'));
          a1.setAttribute('aria-disabled', 'false');
          a1.textContent = 'Download current volunteer application (revision ' + String(revision) + ', ' + status + ')';
        }
        const a2 = $('download-availability-document');
        if (a2 instanceof HTMLAnchorElement) {
          a2.setAttribute('href', getDownloadUrl(caseId, lastExportId, 'availability-equipment'));
          a2.setAttribute('aria-disabled', 'false');
          a2.textContent = 'Download current availability request (revision ' + String(revision) + ', ' + status + ')';
        }
        setStatus('Both forms are ready to download.');
      } else {
        clearDownloads();
        setStatus('Export is not current. Review the packet and retry export.');
      }
    } catch (e) {
      setStatus('Export request needs attention. Review the error for next steps.');
      if (e instanceof ApiError && e.code === 'STALE_REVISION') {
        try {
          await refreshCase();
        } catch {
          // Intentionally ignore refresh errors: STALE_REVISION message already prompts review.
        }
        setError(friendly(e));
      } else setError(friendly(e));
    } finally {
      setBusy(false);
    }
  });
}
async function init(): Promise<void> {
  ensureCorrectionUI();
  setError('');
  setStatus('Loading session...');
  try {
    const s = await initSession();
    providerReady = s.providerReady;
  } catch {
    providerReady = false;
  }
  const providerNotice = $('provider-notice');
  if (providerNotice) providerNotice.hidden = providerReady;
  if (!providerReady) revealRecoveryHelp();
  try {
    const listed = await listCases();
    void listed;
  } catch {
    // Intentionally ignore case-list errors: listing is not required for init.
  }
  const stored = loadStored();
  const inp = $('case-id-input');
  if (stored && inp instanceof HTMLInputElement) inp.value = stored;
  if (stored) {
    try {
      const res = await getCase(stored);
      applyPacket(res, true);
      setStatus('Saved case resumed.');
    } catch {
      setStatus('Saved case unavailable. Start a new case or resume another ID.');
      document.body.dataset.caseActive = 'false';
      renderPacket();
    }
  } else {
    document.body.dataset.caseActive = 'false';
    setStatus('Ready to start a practice packet.');
    renderPacket();
  }
  const createBtn = $('case-create-button');
  if (createBtn) createBtn.addEventListener('click', () => {
    void doCreate();
  });
  const resumeBtn = $('case-resume-button');
  if (resumeBtn) resumeBtn.addEventListener('click', () => {
    const inpEl = $('case-id-input');
    const v = inpEl instanceof HTMLInputElement ? inpEl.value.trim() : '';
    void doResume(v);
  });
  const idInput = $('case-id-input');
  if (idInput) idInput.addEventListener('input', updateButtons);
  const msgForm = $('message-form');
  if (msgForm) msgForm.addEventListener('submit', (e) => {
    e.preventDefault();
    void doSend();
  });
  const corForm = $('correction-form');
  if (corForm) corForm.addEventListener('submit', (e) => {
    e.preventDefault();
    void doCorrect();
  });
  const chk = $('facts-confirm-checkbox');
  if (chk) chk.addEventListener('change', updateButtons);
  const conBtn = $('facts-confirm-button');
  if (conBtn) conBtn.addEventListener('click', () => {
    void doConfirm();
  });
  const expBtn = $('export-button');
  if (expBtn) expBtn.addEventListener('click', () => {
    void doExport();
  });
  document.querySelectorAll<HTMLAnchorElement>('a[href^="#"]').forEach((anchor) => {
    anchor.addEventListener('click', (event) => {
      const targetId = anchor.getAttribute('href')?.slice(1);
      const target = targetId ? $(targetId) : null;
      if (!(target instanceof HTMLElement)) return;
      const disclosures: HTMLDetailsElement[] = [];
      let parent = target.parentElement;
      while (parent) {
        if (parent instanceof HTMLDetailsElement) disclosures.push(parent);
        parent = parent.parentElement;
      }
      if (disclosures.length === 0) return;
      event.preventDefault();
      disclosures.forEach((disclosure) => { disclosure.open = true; });
      if (!target.hasAttribute('tabindex')) target.setAttribute('tabindex', '-1');
      requestAnimationFrame(() => {
        target.focus({ preventScroll: true });
        target.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    });
  });
  updateButtons();
}
void init();

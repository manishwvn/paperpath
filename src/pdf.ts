import { generate } from '@pdfme/generator';
import { text, checkbox } from '@pdfme/schemas';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { Template, Schema } from '@pdfme/common';
import { DomainError, validatePacket } from './domain.ts';
import type { Case, Field, Store } from './domain.ts';

export const formNames = ['application', 'availability-equipment'] as const;
const value = (packet: Case, field: Field) => String(packet.facts[field]?.value ?? 'Unknown');

export async function prepareExport(store: Store, owner: string, packet: Case, directory: string, idempotencyKey: string) {
  if (!validatePacket(packet).complete) throw new DomainError('INCOMPLETE_PACKET');
  const cached = store.cachedExport(owner,packet.id,packet.revision,idempotencyKey);
  if (cached) return cached;
  const id = randomUUID();
  const generatedAt = new Date().toISOString();
  const status = packet.confirmedRevision === packet.revision ? 'Applicant-confirmed' : 'Machine-validated draft';
  const field = (name: string, y: number, height = 12, fontSize = 11): Schema => ({
    ...text.propPanel.defaultSchema, name, position:{x:18,y}, width:174,height,fontSize,
    fontColor:'#16354A',overflow:'expand',
  });
  const footer = `${status} | Revision ${packet.revision} | ${generatedAt}`;
  const shared = {
    program:'Demo Community Volunteer Program. Fictional templates; no agency endorsement.',
    applicant:`Applicant: ${value(packet,'name')}`,
    email:`Contact email: ${value(packet,'email')}`,
    availability:`Availability: ${value(packet,'availability')}`,
    equipment:packet.facts.equipment?.value ? 'true' : 'false',
    equipmentLabel:`Equipment requested: ${packet.facts.equipment?.value ? 'Yes' : 'No'}`,
    evidence:`Availability source: "${packet.facts.availability?.evidence.quote}"`,
  };
  const artifacts = [];
  await mkdir(join(directory,id),{recursive:true});
  for (const name of formNames) {
    const application = name === 'application';
    const schemas = [field('title',20,15,20),field('program',42,15,9),field('applicant',66),
      field('email',84),field('availability',102),
      {...checkbox.propPanel.defaultSchema,name:'equipment',position:{x:18,y:123}},
      {...field('equipmentLabel',123),position:{x:30,y:123},width:160},
      field('extra',146,18,10),field('evidence',178,22,9)];
    const template: Template = {
      basePdf:{width:210,height:297,padding:[18,18,18,18],
        staticSchema:[{...field('footer',280,12,8),readOnly:true,content:footer}]},
      schemas:[schemas],
    };
    const input = {...shared,title:application?'Volunteer application':'Availability and equipment request',
      extra:application?`Why I would like to volunteer: ${value(packet,'motivation')}`:
        'This schedule matches the volunteer application. Correct either view in PaperPath to update both forms.'};
    const bytes = await generate({template,inputs:[input],plugins:{text,checkbox}});
    await writeFile(join(directory,id,`${name}.pdf`),bytes,{mode:0o600});
    artifacts.push({name,sha256:createHash('sha256').update(bytes).digest('hex'),bytes:bytes.length});
  }
  const manifest = {id,caseId:packet.id,revision:packet.revision,generatedAt,status,
    templateVersion:'1',mappingVersion:'1',sourceHashes:packet.sources.map(source=>source.sha256),
    validation:validatePacket(packet),artifacts};
  const saved = store.saveExport(owner,packet.id,packet.revision,id,manifest,idempotencyKey);
  await writeFile(join(directory,id,'manifest.json'),JSON.stringify(manifest,null,2),{mode:0o600});
  return saved;
}

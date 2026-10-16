import express from 'express';
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { z } from 'zod';
import { mkdir, readFile, writeFile, appendFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Store, DomainError, candidateSchema, fields, validatePacket } from './domain.ts';
import type { Case } from './domain.ts';
import { formNames, prepareExport } from './pdf.ts';
import { extractCandidates } from './inference.ts';
import type { Request, Response, NextFunction } from 'express';

process.umask(0o077);
const port = Number(process.env.PORT ?? '4317');
if (!Number.isInteger(port) || port<1024 || port>65535) throw new Error('INVALID_PORT');
const runtime = resolve(process.env.PAPERPATH_DATA_DIR ?? '.local');
await mkdir(runtime,{recursive:true,mode:0o700});
const secretPath = join(runtime,'service-secret.txt');
try { await writeFile(secretPath,randomBytes(32).toString('hex'),{flag:'wx',mode:0o600}); }
catch (error) { if ((error as NodeJS.ErrnoException).code!=='EEXIST') throw error; }
const secret = (await readFile(secretPath,'utf8')).trim();
const store = new Store(join(runtime,'paperpath.sqlite'));
const base = `http://127.0.0.1:${port}`;
const origins = new Set([base,`http://localhost:${port}`]);
const model = process.env.GROQ_MODEL ?? 'openai/gpt-oss-20b';
const approvals = new Map<string,{owner:string;id:string;revision:number}>();
const app = createMcpExpressApp({host:'127.0.0.1'});
const equal = (a:string,b:string) => {
  const left = Buffer.from(a), right = Buffer.from(b);
  return left.length===right.length && timingSafeEqual(left,right);
};
const csrf = (owner:string) => createHmac('sha256',secret).update(`browser:${owner}`).digest('hex');
const uuid = z.string().uuid();
const mutation = z.object({expectedRevision:z.number().int().positive(),idempotencyKey:z.string().regex(/^[a-zA-Z0-9_-]{8,100}$/)});

app.use((req,res,next)=>{
  if (!origins.has(`http://${req.headers.host}`) || (req.headers.origin && !origins.has(req.headers.origin))) {
    return res.status(403).json({error:'INVALID_ORIGIN_OR_HOST'});
  }
  res.setHeader('X-Content-Type-Options','nosniff');
  res.setHeader('Referrer-Policy','no-referrer');
  res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  next();
});

function toolServer(owner:string, approval?:string) {
  const server = new McpServer({name:'PaperPath',version:'0.1.0'});
  const output = async (operation:()=>unknown|Promise<unknown>) => {
    try {
      const data = await operation();
      return {content:[{type:'text' as const,text:JSON.stringify(data)}],structuredContent:data as Record<string,unknown>};
    } catch (error) {
      return {isError:true,content:[{type:'text' as const,text:error instanceof DomainError?error.code:'INVALID_OPERATION'}]};
    }
  };
  server.registerTool('create_case',{description:'Start a durable fictional volunteer packet.',
    inputSchema:{idempotencyKey:z.string()}},args=>output(()=>store.create(owner,args.idempotencyKey)));
  server.registerTool('get_case',{description:'Read the current owned packet and evidence.',inputSchema:{caseId:uuid}},
    args=>output(()=>store.get(owner,args.caseId)));
  const completeMessageArgs = z.object({
    caseId:uuid,
    expectedRevision:z.number().int().positive(),
    idempotencyKey:z.string().regex(/^[a-zA-Z0-9_-]{8,100}$/),
    sourceText:z.string().min(1).max(4000),
    attemptToken:z.string().regex(/^[a-f0-9]{32}$/),
    candidates:z.array(candidateSchema).max(5),
  }).strict();
  server.registerTool('complete_message',{description:'Complete an already acquired owned message reservation.',
    inputSchema:completeMessageArgs},args=>output(()=>{
      const input = completeMessageArgs.parse(args);
      return store.completeMessage(owner,input.caseId,input.expectedRevision,input.idempotencyKey,
        input.sourceText,input.attemptToken,input.candidates);
    }));
  const revisionArgs = {caseId:uuid,expectedRevision:z.number().int().positive(),idempotencyKey:z.string()};
  server.registerTool('propose_facts',{description:'Propose facts explicitly supported by immutable applicant text; differing values become conflicts.',
    inputSchema:{...revisionArgs,sourceText:z.string().min(1).max(4000),candidates:z.array(candidateSchema).max(5)}},
    args=>output(()=>store.propose(owner,args.caseId,args.expectedRevision,args.idempotencyKey,args.sourceText,args.candidates)));
  server.registerTool('correct_fact',{description:'Apply an explicit applicant correction to every mapped form at the expected revision.',
    inputSchema:{...revisionArgs,field:z.enum(fields),value:z.union([z.string().max(1000),z.boolean()])}},
    args=>output(()=>store.correct(owner,args.caseId,args.expectedRevision,args.idempotencyKey,args.field,args.value)));
  server.registerTool('validate_packet',{description:'Report useful missing facts and conflicts before export.',inputSchema:{caseId:uuid}},
    args=>output(()=>validatePacket(store.get(owner,args.caseId))));
  server.registerTool('confirm_packet',{description:'Confirm applicant facts only with a one-time approval from the trusted browser action.',inputSchema:revisionArgs},
    args=>output(()=>{
      const record = approval?approvals.get(approval):undefined;
      const trusted = record?.owner===owner && record.id===args.caseId && record.revision===args.expectedRevision;
      if (approval) approvals.delete(approval);
      return store.confirm(owner,args.caseId,args.expectedRevision,args.idempotencyKey,!!trusted);
    }));
  server.registerTool('prepare_export',{description:'Generate two real, revision-bound PDFs from the current validated canonical packet.',inputSchema:revisionArgs},
    args=>output(async()=>{
      const packet = store.get(owner,args.caseId);
      if (packet.revision!==args.expectedRevision) throw new DomainError('STALE_REVISION');
      return prepareExport(store,owner,packet,join(runtime,'exports'),args.idempotencyKey);
    }));
  return server;
}

app.post('/mcp',async(req,res)=>{
  const owner = req.get('X-PaperPath-Owner') ?? '';
  if (!equal(req.get('Authorization') ?? '',`Bearer ${secret}`) || !store.sessionExists(owner)) {
    return res.status(401).json({error:'MCP_AUTH_REQUIRED'});
  }
  const server = toolServer(owner,req.get('X-PaperPath-Approval'));
  const transport = new StreamableHTTPServerTransport({sessionIdGenerator:undefined,enableJsonResponse:true});
  res.on('close',()=>{void transport.close();void server.close();});
  await server.connect(transport);
  await transport.handleRequest(req,res,req.body);
});
app.get('/mcp',(_req,res)=>res.status(405).end());
app.delete('/mcp',(_req,res)=>res.status(405).end());

async function withMcp<T>(owner:string,action:(client:Client)=>Promise<T>,approval?:string):Promise<T> {
  const client = new Client({name:'PaperPath Alexa+ simulator',version:'0.1.0'});
  const headers:Record<string,string> = {Authorization:`Bearer ${secret}`,'X-PaperPath-Owner':owner};
  if (approval) headers['X-PaperPath-Approval']=approval;
  const transport = new StreamableHTTPClientTransport(new URL('/mcp',base),{
    requestInit:{headers},fetch:async(url,options)=>{
      const response = await fetch(url,options);
      const body = options?.body?JSON.parse(String(options.body)):null;
      await appendFile(join(runtime,'mcp-events.jsonl'),JSON.stringify({at:new Date().toISOString(),
        method:body?.method,protocolHeader:new Headers(options?.headers).get('MCP-Protocol-Version'),status:response.status})+'\n');
      return response;
    },
  });
  try {await client.connect(transport);return await action(client);}
  finally {await client.close();}
}
async function call<T>(client:Client,name:string,args:Record<string,unknown>):Promise<T> {
  const result = await client.callTool({name,arguments:args});
  if (result.isError) {
    const first = result.content as {type:string;text?:string}[];
    throw new DomainError(first[0]?.text??'MCP_TOOL_FAILED');
  }
  return result.structuredContent as T;
}

app.use('/api',(req,res,next)=>{
  if (req.get('Sec-Fetch-Site')==='cross-site') return res.status(403).json({error:'CROSS_SITE_REQUEST'});
  const cookie = req.get('Cookie')?.split(';').map(item=>item.trim()).find(item=>item.startsWith('paperpath_session='))?.split('=')[1];
  const owner = store.session(cookie);
  res.locals.owner = owner;
  res.setHeader('Cache-Control','no-store');
  if (cookie!==owner) res.cookie('paperpath_session',owner,{httpOnly:true,sameSite:'strict',maxAge:90*24*60*60*1000,path:'/'});
  if (!['GET','HEAD'].includes(req.method)) {
    if (!req.headers.origin || !origins.has(req.headers.origin) || !equal(req.get('X-PaperPath-CSRF')??'',csrf(owner))) {
      return res.status(403).json({error:'BROWSER_AUTH_REQUIRED'});
    }
  }
  next();
});
app.get('/health',(_req,res)=>res.json({ok:true,application:'PaperPath',protocol:'2025-11-25'}));
app.get('/api/session',(_req,res)=>res.json({csrf:csrf(res.locals.owner),providerReady:!!process.env.GROQ_API_KEY,model}));
app.get('/api/cases',(_req,res)=>res.json({cases:store.list(res.locals.owner)}));
const state = (packet:Case)=>({packet,validation:validatePacket(packet)});
app.post('/api/cases',async(req,res)=>{
  const args = z.object({idempotencyKey:z.string().min(8).max(100)}).strict().parse(req.body);
  const packet = await withMcp(res.locals.owner,async client=>{
    const created = await call<Case>(client,'create_case',args);
    return call<Case>(client,'get_case',{caseId:created.id});
  });
  res.json(state(packet));
});
app.get('/api/cases/:caseId',async(req,res)=>{
  const caseId = uuid.parse(req.params.caseId);
  const packet = await withMcp(res.locals.owner,client=>call<Case>(client,'get_case',{caseId}));
  res.json(state(packet));
});
// Process-local in-flight dedup only; does not survive restart.
const messageInflight = new Map<string, { fingerprint: string; promise: Promise<Case> }>();
app.post('/api/cases/:caseId/message',async(req,res)=>{
  const caseId = uuid.parse(req.params.caseId);
  const args = mutation.extend({text:z.string().min(1).max(4000)}).strict().parse(req.body);
  const fingerprint = createHash('sha256').update(JSON.stringify({caseId,expectedRevision:args.expectedRevision,text:args.text})).digest('hex');
  const inflightKey = `${res.locals.owner}\0${args.idempotencyKey}`;
  const inflightHit = messageInflight.get(inflightKey);
  if (inflightHit) {
    if (inflightHit.fingerprint!==fingerprint) throw new DomainError('IDEMPOTENCY_CONFLICT');
    const packet = await inflightHit.promise;
    res.json(state(packet));
    return;
  }
  const task = withMcp(res.locals.owner,async client=>{
    if (store.committedMessage(res.locals.owner,caseId,args.expectedRevision,args.idempotencyKey,args.text)) {
      return call<Case>(client,'get_case',{caseId});
    }
    const existing = await call<Case>(client,'get_case',{caseId});
    if (existing.revision!==args.expectedRevision) throw new DomainError('STALE_REVISION');
    const listed = await client.listTools();
    const proposal = listed.tools.find(tool=>tool.name==='propose_facts');
    const candidatesSchema = proposal?.inputSchema.properties?.candidates;
    if (!candidatesSchema) throw new DomainError('MCP_SCHEMA_UNAVAILABLE');
    const candidates = await extractCandidates(args.text,candidatesSchema,{key:process.env.GROQ_API_KEY,model});
    await call<Case>(client,'propose_facts',{caseId,expectedRevision:args.expectedRevision,
      idempotencyKey:args.idempotencyKey,sourceText:args.text,candidates});
    return call<Case>(client,'get_case',{caseId});
  });
  task.catch(()=>{});
  messageInflight.set(inflightKey,{fingerprint,promise:task});
  try {
    const packet = await task;
    res.json(state(packet));
  } finally {
    if (messageInflight.get(inflightKey)?.promise===task) messageInflight.delete(inflightKey);
  }
});
app.post('/api/cases/:caseId/correct',async(req,res)=>{
  const caseId = uuid.parse(req.params.caseId);
  const args = mutation.extend({field:z.enum(fields),value:z.union([z.string().max(1000),z.boolean()])}).strict().parse(req.body);
  const packet = await withMcp(res.locals.owner,async client=>{
    await call<Case>(client,'correct_fact',{caseId,...args});
    return call<Case>(client,'get_case',{caseId});
  });
  res.json(state(packet));
});
app.post('/api/cases/:caseId/confirm',async(req,res)=>{
  const caseId = uuid.parse(req.params.caseId);
  const args = mutation.extend({iConfirm:z.literal(true)}).strict().parse(req.body);
  const approval = randomUUID();
  approvals.set(approval,{owner:res.locals.owner,id:caseId,revision:args.expectedRevision});
  try {
    const packet = await withMcp(res.locals.owner,async client=>{
      await call<Case>(client,'confirm_packet',{
        caseId,expectedRevision:args.expectedRevision,idempotencyKey:args.idempotencyKey});
      return call<Case>(client,'get_case',{caseId});
    },approval);
    res.json(state(packet));
  } finally {approvals.delete(approval);}
});
app.post('/api/cases/:caseId/export',async(req,res)=>{
  const caseId = uuid.parse(req.params.caseId);
  const args = mutation.strict().parse(req.body);
  const exported = await withMcp(res.locals.owner,client=>call<Record<string,unknown>>(client,'prepare_export',{caseId,...args}));
  const packet = await withMcp(res.locals.owner,client=>call<Case>(client,'get_case',{caseId}));
  res.json({...state(packet),export:exported});
});
app.get('/api/cases/:caseId/exports/:exportId/:form',async(req,res)=>{
  const caseId = uuid.parse(req.params.caseId), exportId = uuid.parse(req.params.exportId);
  const form = z.enum(formNames).parse(req.params.form);
  store.exportManifest(res.locals.owner,caseId,exportId);
  const bytes = await readFile(join(runtime,'exports',exportId,`${form}.pdf`));
  store.exportManifest(res.locals.owner,caseId,exportId);
  res.setHeader('Content-Disposition',`attachment; filename="paperpath-${form}.pdf"`);
  res.type('pdf').send(bytes);
});
app.use(express.static(fileURLToPath(new URL('../dist/frontend/',import.meta.url)),{dotfiles:'deny'}));
app.use((error:unknown,_req:Request,res:Response,_next:NextFunction)=>{
  void _next;
  const code = error instanceof DomainError?error.code:error instanceof z.ZodError?'INVALID_INPUT':'INTERNAL_ERROR';
  const status = /STALE|CONFLICT/.test(code)?409:/NOT_FOUND/.test(code)?404:/PROVIDER|GROQ/.test(code)?503:code==='INTERNAL_ERROR'?500:400;
  res.status(status).json({error:code});
});
const http = app.listen(port,'127.0.0.1',()=>console.log(`PaperPath listening at ${base}`));
process.on('SIGTERM',()=>http.close(()=>{store.close();process.exit(0);}));
process.on('SIGINT',()=>http.close(()=>{store.close();process.exit(0);}));

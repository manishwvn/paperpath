import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtemp, readdir, rmdir, unlink, readFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { createServer } from 'node:net';
import { inflateSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const project=fileURLToPath(new URL('..',import.meta.url));
const fetchGuard=fileURLToPath(new URL('./helpers/public-origin-fetch-guard.mjs',import.meta.url));
const formNames=['application','availability-equipment'] as const;
type Response={status:number;headers:{get(name:string):string|null};bytes():Promise<Buffer>;json():Promise<unknown>};

test('HTTP to MCP confirmation and export downloads two readable corrected PDFs',{timeout:30_000},async t=>{
  const dataDir=await mkdtemp(join(tmpdir(),'paperpath-http-journey-'));
  const port=await freePort();
  const base=`http://127.0.0.1:${port}`;
  const child=spawn(process.execPath,['--import',fetchGuard,'--experimental-strip-types','src/server.ts'],{
    cwd:project,env:{PATH:process.env.PATH??'/usr/bin:/bin',LANG:'C.UTF-8',PORT:String(port),
      PAPERPATH_TEST_ALLOWED_FETCH_ORIGIN:base,PAPERPATH_DATA_DIR:dataDir},stdio:['ignore','pipe','pipe'],
  });
  let output='';
  child.stdout.setEncoding('utf8').on('data',(chunk:string)=>{output+=chunk;});
  child.stderr.setEncoding('utf8').on('data',(chunk:string)=>{output+=chunk;});
  let exited=false;
  const childExit=new Promise<{code:number|null;signal:NodeJS.Signals|null}>(resolve=>child.once('exit',(code,signal)=>{
    exited=true;resolve({code,signal});
  }));
  const exportsDir=join(dataDir,'exports');
  const exportState:{id?:string}={};
  t.after(async()=>{
    if(!exited){child.kill('SIGTERM');await boundedExit(childExit,5_000);}
    if(exportState.id){
      const children=await readdir(exportsDir);
      assert.deepEqual(children,[exportState.id],'preserve unexpected export runtime artifacts');
      const artifacts=join(exportsDir,exportState.id);
      const names=(await readdir(artifacts)).sort();
      assert.deepEqual(names,['application.pdf','availability-equipment.pdf','manifest.json'].sort(),
        'preserve unexpected generated files');
      for(const name of names) await unlink(join(artifacts,name));
      await rmdir(artifacts);
      await rmdir(exportsDir);
    }
    for(const name of ['service-secret.txt','paperpath.sqlite','paperpath.sqlite-wal','paperpath.sqlite-shm','mcp-events.jsonl']){
      try{await unlink(join(dataDir,name));}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
    }
    assert.deepEqual(await readdir(dataDir),[],'preserve unexpected runtime files');
    await rmdir(dataDir);
  });

  let session:Response|undefined;
  for(let attempt=0;attempt<100;attempt++){
    try{session=await requestApp(base,`${base}/api/session`);break;}
    catch{await new Promise(resolve=>setTimeout(resolve,50));}
  }
  assert.equal(session?.status,200,output);
  const cookie=(session?.headers.get('set-cookie')??'').split(';',1)[0]!;
  const {csrf}=await session!.json() as {csrf:string};
  const headers={Cookie:cookie,Origin:base,'X-PaperPath-CSRF':csrf,'Content-Type':'application/json'};
  const create=await requestApp(base,`${base}/api/cases`,{method:'POST',headers,body:{idempotencyKey:'http-journey-create-001'}});
  assert.equal(create.status,200,await responseError(create));
  const created=(await create.json() as {packet:{id:string;revision:number}}).packet;

  // Seed fully evidenced synthetic facts through the real MCP endpoint, without invoking a provider.
  const owner=cookie.slice('paperpath_session='.length);
  const secret=(await readFile(join(dataDir,'service-secret.txt'),'utf8')).trim();
  const mcp=new Client({name:'PaperPath integration test',version:'0.1.0'});
  await mcp.connect(new StreamableHTTPClientTransport(new URL('/mcp',base),{
    requestInit:{headers:{Authorization:`Bearer ${secret}`,'X-PaperPath-Owner':owner}},
    fetch:loopbackFetch(base),
  }));
  try{
    const sourceText='My name is Nora Grey. My email is nora@example.test. I can volunteer Thursdays. I need equipment. I want to help the community.';
    const proposal=await mcp.callTool({name:'propose_facts',arguments:{caseId:created.id,expectedRevision:created.revision,
      idempotencyKey:'http-journey-propose-001',sourceText,candidates:[
        {field:'name',value:'Nora Grey',quote:'Nora Grey'},
        {field:'email',value:'nora@example.test',quote:'nora@example.test'},
        {field:'availability',value:'Thursdays',quote:'Thursdays'},
        {field:'equipment',value:true,quote:'I need equipment'},
        {field:'motivation',value:'I want to help the community.',quote:'I want to help the community.'},
      ]}});
    assert.notEqual(proposal.isError,true,JSON.stringify(proposal));
  }finally{await mcp.close();}

  const corrected=await requestApp(base,`${base}/api/cases/${created.id}/correct`,{method:'POST',headers,
    body:{expectedRevision:created.revision+1,idempotencyKey:'http-journey-correct-001',field:'availability',value:'Wednesdays'}});
  assert.equal(corrected.status,200,await responseError(corrected));
  const correctedPacket=(await corrected.json() as {packet:{revision:number;facts:Record<string,{value:unknown}>}}).packet;
  assert.equal(correctedPacket.facts.availability?.value,'Wednesdays');
  const confirmed=await requestApp(base,`${base}/api/cases/${created.id}/confirm`,{method:'POST',headers,
    body:{expectedRevision:correctedPacket.revision,idempotencyKey:'http-journey-confirm-001',iConfirm:true}});
  assert.equal(confirmed.status,200,await responseError(confirmed));
  const confirmedPacket=(await confirmed.json() as {packet:{revision:number;confirmedRevision:number}}).packet;
  assert.equal(confirmedPacket.confirmedRevision,confirmedPacket.revision);

  const exported=await requestApp(base,`${base}/api/cases/${created.id}/export`,{method:'POST',headers,
    body:{expectedRevision:confirmedPacket.revision,idempotencyKey:'http-journey-export-001'}});
  assert.equal(exported.status,200,await responseError(exported));
  const manifest=(await exported.json() as {export:{id:string;status:string;artifacts:{name:string;sha256:string}[]}}).export;
  exportState.id=manifest.id;
  assert.equal(manifest.status,'Applicant-confirmed');
  assert.deepEqual(manifest.artifacts.map(item=>item.name).sort(),[...formNames].sort());
  for(const form of formNames){
    const downloaded=await requestApp(base,`${base}/api/cases/${created.id}/exports/${exportState.id}/${form}`,{headers:{Cookie:cookie}});
    assert.equal(downloaded.status,200);
    const bytes=await downloaded.bytes();
    t.diagnostic(createHash('sha256').update(bytes).digest('hex'));
    assert.ok(bytes.subarray(0,8).toString('latin1').startsWith('%PDF-1.'),'valid PDF header');
    assert.ok(bytes.includes(Buffer.from('%%EOF')),'PDF has an EOF marker');
    const text=extractPdfText(bytes);
    assert.ok(text.includes('Nora Grey'),'PDF text contains the synthetic applicant');
    assert.ok(text.includes('Wednesdays'),'PDF text contains the corrected shared value');
    assert.ok(text.includes(form==='application'?'Volunteer application':'Availability and equipment request'),
      'PDF text contains its expected form title');
    assert.ok(text.includes('Applicant-confirmed'),'PDF text records applicant confirmation');
  }
});

function extractPdfText(bytes:Buffer):string{
  const streams:Buffer[]=[];
  const marker=Buffer.from('stream\n');
  for(let offset=0;(offset=bytes.indexOf(marker,offset))>=0;){
    const start=offset+marker.length;
    const end=bytes.indexOf(Buffer.from('\nendstream'),start);
    if(end<0)break;
    const compressed=bytes.subarray(start,end);
    try{streams.push(inflateSync(compressed));}catch{/* Non-Flate streams are not text candidates. */}
    offset=end+9;
  }
  const contents=streams.map(stream=>stream.toString('latin1'));
  const unicode=new Map<string,string>();
  for(const content of contents){
    for(const block of content.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)){
      for(const pair of block[1]!.matchAll(/<([0-9A-F]{4})>\s*<([0-9A-F]+)>/g)){
        const source=pair[1]!;
        const target=pair[2]!.match(/.{4}/g)?.map(code=>String.fromCodePoint(Number.parseInt(code,16))).join('');
        if(target)unicode.set(source,target);
      }
    }
  }
  return contents.map(content=>content.replace(/<([0-9A-F]{4,})>\s*Tj/g,(_match,hex:string)=>
    (hex.match(/.{4}/g)??[]).map(code=>unicode.get(code)??'').join(''))).join('\n');
}

async function freePort():Promise<number>{
  const server=createServer();
  await new Promise<void>((resolve,reject)=>server.listen(0,'127.0.0.1',resolve).once('error',reject));
  const address=server.address();assert.ok(address&&typeof address!=='string');
  await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));
  return address.port;
}
async function requestApp(expectedOrigin:string,url:string,options:{method?:string;headers?:Record<string,string>;body?:unknown}={}):Promise<Response>{
  const target=new URL(url);
  if(target.origin!==expectedOrigin||target.protocol!=='http:'||target.hostname!=='127.0.0.1')throw new Error('test-http-origin-rejected');
  return new Promise((resolve,reject)=>{
    let settled=false;
    const finishError=(error:Error)=>{if(settled)return;settled=true;clearTimeout(timer);reject(error);};
    const request=httpRequest(target,{method:options.method,headers:options.headers},response=>{
      const chunks:Buffer[]=[];response.on('data',(chunk:Buffer)=>chunks.push(chunk));response.on('end',()=>{
        if(settled)return;settled=true;clearTimeout(timer);
        const bytes=Buffer.concat(chunks);resolve({status:response.statusCode??0,headers:{get:name=>{
          const value=response.headers[name.toLowerCase()];return Array.isArray(value)?value.join(', '):value??null;
        }},bytes:async()=>bytes,json:async()=>JSON.parse(bytes.toString('utf8'))});
      });
      response.once('error',finishError);
    });
    const timer=setTimeout(()=>request.destroy(new Error('test-http-request-timeout')),5_000);
    request.once('error',finishError);
    if(options.body!==undefined)request.write(JSON.stringify(options.body));
    request.end();
  });
}
function loopbackFetch(expectedOrigin:string):typeof fetch{
  return async(input,init={})=>{
    const url=input instanceof URL?input:new URL(typeof input==='string'?input:input.url);
    if(url.origin!==expectedOrigin||url.protocol!=='http:'||url.hostname!=='127.0.0.1'){
      throw new Error('test-mcp-fetch-origin-rejected');
    }
    const timeout=AbortSignal.timeout(5_000);
    const signal=init.signal?AbortSignal.any([init.signal,timeout]):timeout;
    const response=await fetch(url,{...init,signal,redirect:'manual'});
    if(response.status>=300&&response.status<400)throw new Error('test-mcp-fetch-redirect-rejected');
    return response;
  };
}
async function responseError(response:Response):Promise<string>{return JSON.stringify(await response.json());}
async function boundedExit(exit:Promise<{code:number|null;signal:NodeJS.Signals|null}>,timeoutMs:number){
  let timer:NodeJS.Timeout|undefined;
  try{return await Promise.race([exit,new Promise<never>((_resolve,reject)=>{timer=setTimeout(()=>reject(new Error('test-child-exit-timeout')),timeoutMs);})]);}
  finally{if(timer)clearTimeout(timer);}
}

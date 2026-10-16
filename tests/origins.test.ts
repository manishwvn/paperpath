import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readdir, rmdir } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { configureOrigins } from '../src/origins.ts';

const project = fileURLToPath(new URL('..',import.meta.url));
const validOrigin = 'https://paperpath.test';
type AppResponse = {status:number;headers:{get(name:string):string|null};json():Promise<unknown>};

test('public origin config accepts only canonical HTTPS origins and derives exact authorities',()=>{
  const config = configureOrigins('["https://paperpath.test","https://port.paperpath.test:8443"]',4317);
  assert.deepEqual([...config.publicOrigins],['https://paperpath.test','https://port.paperpath.test:8443']);
  assert.ok(config.authorities.has('paperpath.test'));
  assert.ok(config.authorities.has('port.paperpath.test:8443'));
  assert.ok(config.authorities.has('127.0.0.1:4317'));
  assert.ok(config.hostnames.has('port.paperpath.test'));
  assert.equal(configureOrigins(undefined,4317).publicOrigins.size,0);
  assert.equal(configureOrigins('[]',4317).publicOrigins.size,0);
  for (const invalid of [
    'null', '{}', '[1]', '["http://paperpath.test"]', '["https://paperpath.test/"]',
    '["https://paperpath.test:443"]', '["https://user:pass@paperpath.test"]',
    '["https://paperpath.test/path"]', '["https://paperpath.test?x=1"]',
    '["https://paperpath.test#fragment"]', '["https://*.paperpath.test"]',
    '["https://paperpath.test "]',
  ]) assert.throws(()=>configureOrigins(invalid,4317),{message:'INVALID_PUBLIC_ORIGINS'});
});

test('configured public authority serves HTTP and MCP-backed API; rejects cross-paired origins',async t=>{
  const dataDir = await mkdtemp(join(tmpdir(),'paperpath-public-origin-'));
  const port = await freePort();
  const child = spawn(process.execPath,['--experimental-strip-types','src/server.ts'],{
    cwd:project,
    env:{PATH:process.env.PATH??'/usr/bin:/bin',LANG:'C.UTF-8',PORT:String(port),
      PAPERPATH_DATA_DIR:dataDir,PAPERPATH_PUBLIC_ORIGINS:JSON.stringify([validOrigin])},
    stdio:['ignore','pipe','pipe'],
  });
  let output = '';
  child.stdout.setEncoding('utf8').on('data',(chunk:string)=>{output+=chunk;});
  child.stderr.setEncoding('utf8').on('data',(chunk:string)=>{output+=chunk;});
  let exited = false;
  child.once('exit',()=>{exited=true;});
  t.after(async()=>{
    if (!exited) {
      child.kill('SIGTERM');
      await new Promise<void>(resolve=>child.once('exit',()=>resolve()));
    }
    for (const name of await readdir(dataDir)) {
      const { unlink } = await import('node:fs/promises');
      await unlink(join(dataDir,name));
    }
    await rmdir(dataDir);
  });

  const base = `http://127.0.0.1:${port}`;
  const headers = {'Host':'paperpath.test','Origin':validOrigin};
  let health:AppResponse|undefined;
  for (let attempt=0;attempt<100;attempt++) {
    try { health=await requestApp(`${base}/health`,{headers}); break; }
    catch { await new Promise(resolve=>setTimeout(resolve,50)); }
  }
  assert.equal(health?.status,200,output);
  const rejected = await requestApp(`${base}/api/session`,{headers:{Host:`127.0.0.1:${port}`,Origin:validOrigin}});
  assert.equal(rejected.status,403,'configured public Origin cannot pair with loopback Host');
  const nullOrigin = await requestApp(`${base}/health`,{headers:{...headers,Origin:'null'}});
  assert.equal(nullOrigin.status,403,'opaque Origin is rejected');
  const spoofed = await requestApp(`${base}/health`,{headers:{Host:'attacker.test','X-Forwarded-Host':'paperpath.test',Origin:validOrigin}});
  assert.equal(spoofed.status,403,'forwarded host does not grant authority');

  const mcpAuth = await requestApp(`${base}/mcp`,{method:'POST',headers:{...headers,'Content-Type':'application/json'},body:'{}'});
  assert.equal(mcpAuth.status,401,'configured public authority passes SDK Host validation before MCP auth');
  const mcpBadHost = await requestApp(`${base}/mcp`,{method:'POST',headers:{Host:'attacker.test',Origin:validOrigin,'Content-Type':'application/json'},body:'{}'});
  assert.equal(mcpBadHost.status,403);

  const session = await requestApp(`${base}/api/session`,{headers});
  assert.equal(session.status,200);
  const cookie = session.headers.get('set-cookie') ?? '';
  assert.match(cookie,/paperpath_session=/);
  assert.match(cookie,/; Secure/i,'public authority gets a Secure session cookie');
  const loopbackSession = await requestApp(`${base}/api/session`,{headers:{Host:`127.0.0.1:${port}`}});
  assert.doesNotMatch(loopbackSession.headers.get('set-cookie')??'',/; Secure/i,'loopback cookie keeps existing HTTP behavior');
  const {csrf} = await session.json() as {csrf:string};
  const created = await requestApp(`${base}/api/cases`,{method:'POST',headers:{...headers,Cookie:cookie.split(';',1)[0],
    'X-PaperPath-CSRF':csrf,'Content-Type':'application/json'},body:JSON.stringify({idempotencyKey:'public-origin-case-001'})});
  assert.equal(created.status,200,'API request completes through loopback MCP client');
  assert.ok((await created.json() as {packet:{id:string}}).packet.id);
});

test('invalid public-origin config exits before creating runtime files',async()=>{
  const dataDir = await mkdtemp(join(tmpdir(),'paperpath-invalid-origin-'));
  const port = await freePort();
  const child = spawn(process.execPath,['--experimental-strip-types','src/server.ts'],{
    cwd:project,
    env:{PATH:process.env.PATH??'/usr/bin:/bin',LANG:'C.UTF-8',PORT:String(port),
      PAPERPATH_DATA_DIR:dataDir,PAPERPATH_PUBLIC_ORIGINS:'["http://paperpath.test"]'},
    stdio:['ignore','pipe','pipe'],
  });
  let output='';
  child.stdout.setEncoding('utf8').on('data',(chunk:string)=>{output+=chunk;});
  child.stderr.setEncoding('utf8').on('data',(chunk:string)=>{output+=chunk;});
  const code = await new Promise<number|null>((resolve,reject)=>{
    child.once('error',reject);
    child.once('exit',resolve);
  });
  assert.notEqual(code,0);
  assert.match(output,/INVALID_PUBLIC_ORIGINS/);
  assert.deepEqual(await readdir(dataDir),[]);
  await rmdir(dataDir);
});

async function freePort():Promise<number> {
  const server=createServer();
  await new Promise<void>((resolve,reject)=>server.listen(0,'127.0.0.1',()=>resolve()).once('error',reject));
  const address=server.address();
  assert.ok(address&&typeof address!=='string');
  const port=address.port;
  await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));
  return port;
}

async function requestApp(url:string,options:{method?:string;headers?:Record<string,string>;body?:string}={}) {
  return new Promise<{status:number;headers:{get(name:string):string|null};json():Promise<unknown>}>((resolve,reject)=>{
    const request=httpRequest(new URL(url),{method:options.method,headers:options.headers},response=>{
      const chunks:Buffer[]=[];
      response.on('data',(chunk:Buffer)=>chunks.push(chunk));
      response.on('end',()=>{
        const body=Buffer.concat(chunks).toString('utf8');
        resolve({status:response.statusCode??0,headers:{get:name=>{
          const value=response.headers[name.toLowerCase()];
          return Array.isArray(value)?value.join(', '):value??null;
        }},json:async()=>JSON.parse(body)});
      });
    });
    request.once('error',reject);
    if (options.body!==undefined) request.write(options.body);
    request.end();
  });
}

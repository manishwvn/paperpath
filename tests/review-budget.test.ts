import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractCandidates, getExtractionOutcome } from '../src/inference.ts';
import { createReviewProviderRequestBudget, parseReviewProviderRequestLimit } from '../src/review-budget.ts';
import { DomainError } from '../src/domain.ts';

const MESSAGE = 'My name is Sam Lee.';
const KEY = 'test-key';
const MODEL = 'test-model';

function response(): Response {
  return new Response(JSON.stringify({choices:[{message:{tool_calls:[{
    function:{name:'propose_facts',arguments:JSON.stringify({candidates:[]})}
  }]}}]}),{status:200,headers:{'Content-Type':'application/json'}});
}

test('review limit is opt-in and accepts only the approved maximum', () => {
  assert.equal(parseReviewProviderRequestLimit(undefined),undefined);
  assert.equal(parseReviewProviderRequestLimit('3'),3);
  assert.throws(()=>parseReviewProviderRequestLimit('4'),/INVALID_PAPERPATH_REVIEW_REQUEST_LIMIT/);
  assert.throws(()=>parseReviewProviderRequestLimit('unlimited'),/INVALID_PAPERPATH_REVIEW_REQUEST_LIMIT/);
});

test('one process-scoped gate allows exactly three concurrent fetches and refuses later attempts as not-started', async () => {
  const budget=createReviewProviderRequestBudget(3);
  let fetchCalls=0;
  const fetcher=(async()=>{fetchCalls+=1;return response()}) as unknown as typeof fetch;
  const outcomes=await Promise.all(Array.from({length:5},async()=>{
    try {
      await extractCandidates(MESSAGE,{}, {key:KEY,model:MODEL,fetcher,beforeProviderRequest:()=>budget.beforeRequest()});
      return 'success';
    } catch(error) {
      assert.ok(error instanceof DomainError);
      return {code:error.code,outcome:getExtractionOutcome(error)};
    }
  }));
  assert.equal(fetchCalls,3);
  assert.equal(budget.used(),3);
  assert.equal(outcomes.filter(value=>value==='success').length,3);
  assert.deepEqual(outcomes.filter(value=>typeof value==='object'),[
    {code:'REVIEW_PROVIDER_LIMIT',outcome:'not-started'},
    {code:'REVIEW_PROVIDER_LIMIT',outcome:'not-started'},
  ]);
});

test('a failed outbound request consumes its review slot and a later cap rejection does not invoke fetch', async () => {
  const budget=createReviewProviderRequestBudget(3);
  let fetchCalls=0;
  const fetcher=(async()=>{fetchCalls+=1;return new Response('{}',{status:429})}) as unknown as typeof fetch;
  for (let attempt=0;attempt<3;attempt+=1) {
    await assert.rejects(
      extractCandidates(MESSAGE,{}, {key:KEY,model:MODEL,fetcher,beforeProviderRequest:()=>budget.beforeRequest()}),
      error=>error instanceof DomainError&&error.code==='PROVIDER_RATE_LIMIT'&&getExtractionOutcome(error)==='unknown'
    );
  }
  await assert.rejects(
    extractCandidates(MESSAGE,{}, {key:KEY,model:MODEL,fetcher,beforeProviderRequest:()=>budget.beforeRequest()}),
    error=>error instanceof DomainError&&error.code==='REVIEW_PROVIDER_LIMIT'&&getExtractionOutcome(error)==='not-started'
  );
  assert.equal(fetchCalls,3);
  assert.equal(budget.used(),3);
});

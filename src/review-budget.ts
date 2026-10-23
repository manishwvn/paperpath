import { DomainError } from './domain.ts';

export const REVIEW_PROVIDER_REQUEST_LIMIT = 3;

export function parseReviewProviderRequestLimit(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (value !== String(REVIEW_PROVIDER_REQUEST_LIMIT)) {
    throw new Error('INVALID_PAPERPATH_REVIEW_REQUEST_LIMIT');
  }
  return REVIEW_PROVIDER_REQUEST_LIMIT;
}

export function createReviewProviderRequestBudget(limit: number | undefined) {
  if (limit !== undefined && limit !== REVIEW_PROVIDER_REQUEST_LIMIT) {
    throw new Error('INVALID_PAPERPATH_REVIEW_REQUEST_LIMIT');
  }
  let used = 0;
  return {
    beforeRequest(): number {
      if (limit !== undefined && used >= limit) {
        const error = new DomainError('REVIEW_PROVIDER_LIMIT') as DomainError & { outcome: 'not-started' };
        error.outcome = 'not-started';
        throw error;
      }
      used += 1;
      return used;
    },
    used(): number { return used; },
  };
}

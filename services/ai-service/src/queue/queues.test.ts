import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { GenerationJobData } from '../types/generation.js';
import {
  GENERATION_QUEUE_NAME,
  __getMockJobs,
  _resetQueuesForTests,
  generationJobName,
  getGenerationFlowProducer,
  getGenerationQueue,
  orgPriorityBucket,
} from './queues.js';

const baseData: GenerationJobData = {
  jobId: 'job-1',
  generationRequestId: 'req-1',
  org: 'acme',
  project: 'proj-1',
  unitKey: 'u1',
};

beforeEach(async () => {
  await _resetQueuesForTests();
});

afterEach(async () => {
  await _resetQueuesForTests();
});

describe('queue singletons', () => {
  it('getGenerationQueue returns the same instance across calls', () => {
    const a = getGenerationQueue();
    const b = getGenerationQueue();
    expect(a).toBe(b);
  });

  it('getGenerationFlowProducer returns the same instance across calls', () => {
    const a = getGenerationFlowProducer();
    const b = getGenerationFlowProducer();
    expect(a).toBe(b);
  });
});

describe('mock queue (test mode)', () => {
  it('queue.add stashes the job in __mockJobs', async () => {
    const q = getGenerationQueue();
    const job = await q.add(generationJobName('acme', 'ixd'), baseData);
    const stashed = __getMockJobs(q);
    expect(stashed).toHaveLength(1);
    expect(stashed[0]?.id).toBe(job.id);
    expect(stashed[0]?.name).toBe('generation:acme:ixd');
    expect(stashed[0]?.data).toEqual(baseData);
  });

  it('queue.remove returns 1 for an existing job, 0 for an unknown one', async () => {
    const q = getGenerationQueue();
    const job = await q.add(generationJobName('acme'), baseData);
    const jobId = job.id;
    if (!jobId) throw new Error('expected mock job to have an id');
    expect(await q.remove(jobId)).toBe(1);
    expect(await q.remove(jobId)).toBe(0);
    expect(await q.remove('does-not-exist')).toBe(0);
  });
});

describe('flow producer (test mode)', () => {
  it('expands parent/child into the same mock queue __mockJobs', async () => {
    const q = getGenerationQueue();
    const flow = getGenerationFlowProducer();

    const childData: GenerationJobData = { ...baseData, unitKey: 'child' };
    const parentData: GenerationJobData = { ...baseData, unitKey: 'parent' };

    const node = await flow.add({
      name: generationJobName('acme', 'parent'),
      queueName: GENERATION_QUEUE_NAME,
      data: parentData,
      children: [
        {
          name: generationJobName('acme', 'child'),
          queueName: GENERATION_QUEUE_NAME,
          data: childData,
        },
      ],
    });

    const stashed = __getMockJobs(q);
    expect(stashed).toHaveLength(2);
    const names = stashed.map((j) => j.name).sort();
    expect(names).toEqual(['generation:acme:child', 'generation:acme:parent']);
    expect(node.children).toHaveLength(1);
    expect(node.job.name).toBe('generation:acme:parent');
  });
});

describe('generationJobName', () => {
  it('formats with unitType', () => {
    expect(generationJobName('acme', 'ixd')).toBe('generation:acme:ixd');
  });

  it('falls back to "untyped" when unitType is omitted', () => {
    expect(generationJobName('acme')).toBe('generation:acme:untyped');
  });
});

describe('orgPriorityBucket', () => {
  it('returns a value in [1, 10]', () => {
    for (const org of ['acme', 'globex', 'initech', 'a', '']) {
      const b = orgPriorityBucket(org);
      expect(b).toBeGreaterThanOrEqual(1);
      expect(b).toBeLessThanOrEqual(10);
    }
  });

  it('is stable across calls for the same input', () => {
    expect(orgPriorityBucket('acme')).toBe(orgPriorityBucket('acme'));
    expect(orgPriorityBucket('globex')).toBe(orgPriorityBucket('globex'));
  });
});

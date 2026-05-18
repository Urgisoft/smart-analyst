/**
 * T-R1 — readHashParams (Phase 2 §5.5 SPEC §3.7).
 *
 * Pure-function test for the validator route's URL-param hydration helper.
 * Covers the example matrix the SPEC pinned + a few additional rejection paths
 * (cluster_id < 0 = HDBSCAN noise; non-integer; missing axis; etc.).
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readHashParams } from '../../src/lib/validator_hash_params.js';

describe('T-R1 — readHashParams', () => {
  test('#/cluster (no `?`) returns null', () => {
    assert.equal(readHashParams('#/cluster'), null);
  });

  test('#/validator (no params) returns null', () => {
    assert.equal(readHashParams('#/validator'), null);
  });

  test('cluster axis URL with valid params is parsed', () => {
    const r = readHashParams('#/validator?axis=cluster&strategy=mean_reversion_v1&clusterId=0&interval=1d');
    assert.deepEqual(r, {
      axis: 'cluster',
      strategy: 'mean_reversion_v1',
      clusterId: 0,
      interval: '1d',
    });
  });

  test('cluster axis with non-numeric clusterId returns null', () => {
    assert.equal(readHashParams('#/validator?axis=cluster&strategy=x&clusterId=abc&interval=1d'), null);
  });

  test('cluster axis with non-integer clusterId returns null', () => {
    assert.equal(readHashParams('#/validator?axis=cluster&strategy=x&clusterId=1.5&interval=1d'), null);
  });

  test('cluster axis with negative clusterId returns null (HDBSCAN noise)', () => {
    // -1 is the HDBSCAN noise label; not a cluster, structurally rejected
    // here AND on the server (validator_cluster_request.ts:55).
    assert.equal(readHashParams('#/validator?axis=cluster&strategy=x&clusterId=-1&interval=1d'), null);
  });

  test('cluster axis without clusterId returns null', () => {
    assert.equal(readHashParams('#/validator?axis=cluster&strategy=x&interval=1d'), null);
  });

  test('tier axis URL with valid params is parsed', () => {
    const r = readHashParams('#/validator?axis=tier&strategy=mean_reversion_v1&tier=mcap_micro&interval=1d');
    assert.deepEqual(r, {
      axis: 'tier',
      strategy: 'mean_reversion_v1',
      tier: 'mcap_micro',
      interval: '1d',
    });
  });

  test('tier axis with missing tier defaults to empty string', () => {
    // Empty fields are honest — the form lands with the field blank rather
    // than failing to hydrate and losing strategy/interval too.
    const r = readHashParams('#/validator?axis=tier&strategy=x&interval=1d');
    assert.deepEqual(r, { axis: 'tier', strategy: 'x', tier: '', interval: '1d' });
  });

  test('unknown axis returns null', () => {
    assert.equal(readHashParams('#/validator?axis=kmeans&strategy=x&interval=1d'), null);
  });

  test('missing axis returns null', () => {
    assert.equal(readHashParams('#/validator?strategy=x&interval=1d'), null);
  });

  test('cluster_id boundary at 0 is accepted', () => {
    // 0 is a real cluster_id (the production cluster_solana_mid cohort).
    const r = readHashParams('#/validator?axis=cluster&strategy=x&clusterId=0&interval=1d');
    assert.notEqual(r, null);
    if (r) assert.equal(r.axis === 'cluster' && r.clusterId, 0);
  });

  test('strategy/interval default to empty when not supplied', () => {
    const r = readHashParams('#/validator?axis=cluster&clusterId=0');
    assert.deepEqual(r, { axis: 'cluster', strategy: '', clusterId: 0, interval: '' });
  });
});

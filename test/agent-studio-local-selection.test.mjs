import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_STUDIO_MISSION } from '../lib/replay/agent-simulation-commerce.mjs';
import { suggestStudioProduct, LocalSelectionError } from '../lib/replay/agent-studio-local-selection.mjs';

test('local model receives only eligible products as selectable stock', async () => {
  let seen;
  const result = await suggestStudioProduct(DEFAULT_STUDIO_MISSION, { decisions: {
    async chooseProduct(mission, catalog) {
      seen = { mission, catalog };
      return { productId: 'harbor-studio', model: 'local-test' };
    },
  } });
  assert.equal(result.productId, 'harbor-studio');
  assert.equal(result.provider, 'lmstudio');
  assert.equal(result.paymentCalls, 0);
  assert.equal(seen.catalog.length, 6);
  assert.equal(seen.catalog.find(item => item.id === 'summit-max').stock, 0);
  assert.equal(seen.catalog.find(item => item.id === 'cedar-classic').stock, 0);
  assert.equal(seen.catalog.find(item => item.id === 'aurora-pro').stock, 8);
  assert.match(seen.mission, /Do not purchase/);
});

test('ineligible model choice fails closed', async () => {
  await assert.rejects(() => suggestStudioProduct(DEFAULT_STUDIO_MISSION, { decisions: {
    async chooseProduct() { return { productId: 'summit-max', model: 'local-test' }; },
  } }), error => error instanceof LocalSelectionError && error.code === 'LOCAL_SELECTION_INVALID');
});

test('invalid or impossible mission avoids a model call', async () => {
  let calls = 0;
  const decisions = { async chooseProduct() { calls++; throw Error('unexpected'); } };
  await assert.rejects(() => suggestStudioProduct({ ...DEFAULT_STUDIO_MISSION, maxTotalMinor: 0 }, { decisions }),
    error => error.code === 'INVALID_STUDIO_MISSION');
  await assert.rejects(() => suggestStudioProduct({ ...DEFAULT_STUDIO_MISSION, batteryHoursMin: 200 }, { decisions }),
    error => error.code === 'NO_ELIGIBLE_PRODUCT');
  assert.equal(calls, 0);
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createAgentScenario } from '../lib/replay/agent-simulation-fixtures.mjs';
import { advanceScenarioCursor, nextScenarioAction } from '../lib/replay/agent-simulation-navigation.mjs';
import { presentEventRoute, replayPhase, STUDIO_PARTICIPANTS } from '../lib/replay/agent-simulation-presentation.mjs';

test('every teaching event routes between its actual endpoints', () => {
  for (const fault of ['none', 'buyer_decline', 'lost_response', 'lost_response_recovered', 'token_expired']) {
    for (const event of createAgentScenario({ fault }).events) {
      const route = presentEventRoute(event);
      if (event.actor === 'Simulation') {
        assert.equal(route.kind, 'system');
        assert.equal(route.sender, 'Simulation');
      } else {
        assert.equal(route.kind, 'message');
        assert.equal(route.sender, event.actor);
        assert.equal(route.receiver, event.recipient);
        assert.equal(STUDIO_PARTICIPANTS[route.from / 20].id, event.actor);
        assert.equal(STUDIO_PARTICIPANTS[route.to / 20].id, event.recipient);
      }
      assert.ok(replayPhase(event) >= 0 && replayPhase(event) <= 5);
    }
  }
  const success = createAgentScenario();
  const wallet = success.events.find(event => event.type === 'wallet.token_issued');
  const provider = success.events.find(event => event.type === 'seller.payment_requested');
  assert.deepEqual([presentEventRoute(wallet).sender, presentEventRoute(wallet).receiver], ['Wallet', 'Atlas']);
  assert.deepEqual([presentEventRoute(provider).sender, presentEventRoute(provider).receiver], ['Seller backend', 'Payment simulator']);
});

test('presentation preserves the buyer decision gate', () => {
  const scenario = createAgentScenario();
  const consent = scenario.events.findIndex(event => event.type === 'buyer.purchase_approved');
  assert.equal(nextScenarioAction(scenario, consent), 'buyer.purchase_approved');
  assert.equal(advanceScenarioCursor(scenario, consent), consent);
  assert.equal(advanceScenarioCursor(scenario, consent, 'buyer.purchase_approved'), consent + 1);
  assert.equal(presentEventRoute(scenario.events[consent]).kind, 'message');
});

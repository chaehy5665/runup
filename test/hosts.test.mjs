import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { classifyHost, compareOrigins } from '../src/live/hosts.mjs';

describe('live host names', () => {
  it('sends loopback names to the compare page and the two side names to their apps', () => {
    assert.equal(classifyHost('localhost:4545'), 'ui');
    assert.equal(classifyHost('127.0.0.1:4545'), 'ui');
    assert.equal(classifyHost('localhost'), 'ui');
    assert.equal(classifyHost('base.localhost:4545'), 'base');
    assert.equal(classifyHost('HEAD.localhost:8000'), 'head');
  });

  it('refuses every other name, including rebound look-alikes', () => {
    for (const host of [
      'base.attacker.example:4545',
      'head.attacker.example',
      'base.localhost.attacker.example:4545',
      'attacker.example:4545',
      'x.base.localhost:4545',
      'localhost.:4545',
      '192.168.0.10:4545',
      '[::1]:4545',
      'evil@localhost:4545',
      'localhost:4545/x',
      '',
      undefined,
    ]) {
      assert.equal(classifyHost(host), null, String(host));
    }
  });

  it('takes only the plain loopback names on split ports', () => {
    assert.equal(classifyHost('localhost:4546', 'ports'), 'ui');
    assert.equal(classifyHost('base.localhost:4546', 'ports'), null);
  });

  it('works out the compare page origins from the pane host, or the UI port on split ports', () => {
    assert.deepEqual(compareOrigins('head.localhost:4545', { uiPort: 4545 }), ['http://localhost:4545', 'http://127.0.0.1:4545']);
    // An SSH tunnel on another local port: the compare page shares the pane's port.
    assert.deepEqual(compareOrigins('base.localhost:8000', { uiPort: 4545 }), ['http://localhost:8000', 'http://127.0.0.1:8000']);
    assert.deepEqual(compareOrigins('base.localhost', { uiPort: 4545 }), ['http://localhost', 'http://127.0.0.1']);
    assert.deepEqual(compareOrigins('localhost:4546', { hosts: 'ports', uiPort: 4545 }), ['http://localhost:4545', 'http://127.0.0.1:4545']);
  });
});

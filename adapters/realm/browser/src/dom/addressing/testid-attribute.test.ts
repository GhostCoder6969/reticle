/**
 * Elastic UI marks controls `data-test-subj` and Cypress codebases `data-cy`; the `testid` locator
 * only read `data-testid`, so `{ testid: "pagination-button-next" }` reported "matched no element" on
 * a button that was on screen. A project now names its attribute, and a miss says which one it found.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { QueryBy } from '@reticlehq/core';
import { runQuery } from '../query.js';
import { isSensitiveField } from '../a11y.js';
import { Reticle } from '../../reticle.js';
import { setTestIdAttr, getTestIdAttr } from './testid-attr.js';

const BUTTON = '<button data-test-subj="next">Next</button>';

describe('configurable test-id attribute', () => {
  beforeEach(() => {
    document.body.innerHTML = BUTTON;
  });
  afterEach(() => setTestIdAttr(undefined));

  it('resolves a testid under the configured attribute', () => {
    setTestIdAttr('data-test-subj');
    expect(runQuery({ by: QueryBy.TESTID, value: 'next' }).count).toBe(1);
  });

  it('leaves the default unchanged: data-testid still resolves, other attributes do not', () => {
    document.body.innerHTML = '<button data-testid="a">A</button>' + BUTTON;
    expect(runQuery({ by: QueryBy.TESTID, value: 'a' }).count).toBe(1);
    expect(runQuery({ by: QueryBy.TESTID, value: 'next' }).count).toBe(0);
  });

  it('names the attribute that holds the value when a testid query misses', () => {
    const hint = runQuery({ by: QueryBy.TESTID, value: 'next' }).hint;
    expect(hint?.testidFoundUnder).toBe('data-test-subj');
  });

  it('says nothing extra when the value is not on the page under any attribute', () => {
    expect(runQuery({ by: QueryBy.TESTID, value: 'nope' }).hint?.testidFoundUnder).toBeUndefined();
  });

  it('advertises present testids from the configured attribute', () => {
    setTestIdAttr('data-test-subj');
    document.body.innerHTML = BUTTON;
    expect(runQuery({ by: QueryBy.TESTID, value: 'gone' }).hint?.presentTestids).toEqual(['next']);
  });

  it('ignores a value that is not a plain attribute name', () => {
    setTestIdAttr('x]; drop');
    expect(getTestIdAttr()).toBe('data-testid');
  });
});

describe('safety of a configured attribute', () => {
  afterEach(() => setTestIdAttr(undefined));

  it.each(['data.test', 'xlink:foo', 'x],[onclick'])(
    'falls back to the default for %s instead of making every query throw',
    (name) => {
      setTestIdAttr(name);
      expect(getTestIdAttr()).toBe('data-testid');
      document.body.innerHTML = '<button data-testid="a">A</button>';
      expect(runQuery({ by: QueryBy.TESTID, value: 'a' }).count).toBe(1);
    },
  );

  it('still treats a data-testid secret as sensitive after another attribute is configured', () => {
    setTestIdAttr('data-cy');
    document.body.innerHTML = '<input data-testid="api-key" value="s3cret">';
    const input = document.querySelector('input');
    expect(input && isSensitiveField(input)).toBe(true);
  });

  it('names the default attribute when a switched project misses an old testid', () => {
    setTestIdAttr('data-cy');
    document.body.innerHTML = '<button data-testid="old">Old</button>';
    expect(runQuery({ by: QueryBy.TESTID, value: 'old' }).hint?.testidFoundUnder).toBe(
      'data-testid',
    );
  });
});

describe('connect() wiring', () => {
  const sdk = new Reticle();
  afterEach(() => {
    sdk.disconnect();
    setTestIdAttr(undefined);
  });

  it('applies testIdAttribute so a testid query resolves', () => {
    document.body.innerHTML = '<button data-cy="go">Go</button>';
    sdk.connect({ testIdAttribute: 'data-cy', token: 't' });
    expect(runQuery({ by: QueryBy.TESTID, value: 'go' }).count).toBe(1);
  });
});

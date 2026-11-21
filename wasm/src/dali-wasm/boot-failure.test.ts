import { beforeEach, describe, expect, it } from 'vitest';
import { readBootFailureFlag, registerBootFailure, writeBootFailureFlag } from './boot-failure';

describe('the two-strike boot failure memory', () => {
  beforeEach(() => window.sessionStorage.clear());

  it('does not call the first failure a second strike', () => {
    expect(registerBootFailure()).toBe(false);
    expect(readBootFailureFlag()).toBe(true);
  });

  it('calls two failures in a row a second strike', () => {
    registerBootFailure();
    expect(registerBootFailure()).toBe(true);
  });

  it('a successful boot between failures resets the count', () => {
    registerBootFailure();
    writeBootFailureFlag(false);
    expect(registerBootFailure()).toBe(false);
  });
});

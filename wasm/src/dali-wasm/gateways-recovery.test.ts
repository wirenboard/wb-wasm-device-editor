import { beforeEach, describe, expect, it } from 'vitest';
import { loadRememberedGateways, SCAN_RESULTS_KEY } from './gateways';

describe('loadRememberedGateways: the cleared-profile recovery path', () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
  });

  it('rebuilds gateways from the scan snapshot when localStorage is gone', () => {
    window.sessionStorage.setItem(SCAN_RESULTS_KEY, JSON.stringify([
      {
        device_signature: 'WBMDALI',
        cfg: { slave_id: 17, baud_rate: 115200, data_bits: 8, parity: 'N', stop_bits: 2 },
      },
      // A malformed entry without an address must be skipped, not crash.
      { device_signature: 'WBMDALI', cfg: {} },
      // A non-DALI device is not a gateway.
      {
        device_signature: 'WBMR6C',
        cfg: { slave_id: 3, baud_rate: 9600, data_bits: 8, parity: 'N', stop_bits: 2 },
      },
    ]));
    const gateways = loadRememberedGateways();
    expect(gateways).toHaveLength(1);
    expect(gateways[0]).toMatchObject({ id: 'wb-dali_17', slaveId: 17 });
  });

  it('returns nothing when neither record exists', () => {
    expect(loadRememberedGateways()).toEqual([]);
  });
});

import { beforeEach, describe, expect, it } from 'vitest';
import {
  findDaliGateways,
  isDaliGateway,
  loadRememberedGateways,
  rememberGateways,
  scenarioForGateways,
} from './gateways';

const scanned = [
  { cfg: { slave_id: 17, baud_rate: 115200, data_bits: 8, parity: 'N', stop_bits: 2 }, type: 'WB-DALI' },
  { cfg: { slave_id: 3, baud_rate: 9600, data_bits: 8, parity: 'N', stop_bits: 2 }, type: 'WB-MR6C' },
  { cfg: { slave_id: 9, baud_rate: 9600, data_bits: 8, parity: 'N', stop_bits: 2 }, type: 'WB-MDALI' },
];

describe('gateway discovery', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('recognises both WB-DALI signatures and nothing else', () => {
    expect(isDaliGateway('WB-DALI')).toBe(true);
    expect(isDaliGateway('WB-MDALI')).toBe(true);
    expect(isDaliGateway('WB-MR6C')).toBe(false);
    expect(isDaliGateway(undefined)).toBe(false);
  });

  it('names gateways the way wb-mqtt-dali does and keeps their line settings', () => {
    const gateways = findDaliGateways(scanned, (device) => device.type);
    expect(gateways.map((gateway) => gateway.id)).toEqual(['wb-dali_17', 'wb-dali_9']);
    expect(gateways[0].serial.baud_rate).toBe(115200);
    expect(gateways[1].serial.baud_rate).toBe(9600);
  });

  it('describes the found gateways to the runtime with three empty buses each', () => {
    const scenario = scenarioForGateways(findDaliGateways(scanned, (device) => device.type));
    expect(scenario.gateways[0]).toEqual({ id: 'wb-dali_17', slaveId: 17, buses: { 1: {}, 2: {}, 3: {} } });
    expect(scenario.serialSettings?.baud_rate).toBe(115200);
  });

  it('remembers gateways across views and ignores junk', () => {
    rememberGateways(findDaliGateways(scanned, (device) => device.type));
    expect(loadRememberedGateways().map((gateway) => gateway.slaveId)).toEqual([17, 9]);
    window.localStorage.setItem('wb-dali-gateways', '[{"nope": true}, 42]');
    expect(loadRememberedGateways()).toEqual([]);
  });
});

/**
 * Canned portScan device results.
 * Format matches the Device interface from wasm/src/device-settings-wasm/types.ts.
 * Uses real device type and hardware signatures from the template.
 */
import { map3et } from './device-types';

export const scannedDevices = [
  {
    device_signature: map3et.device_type,
    fw_signature: map3et.device_type,
    sn: '12345',
    fw: { version: '2.5.0' },
    cfg: {
      slave_id: 1,
      baud_rate: 9600,
      data_bits: 8,
      parity: 'N',
      stop_bits: 2,
    },
  },
];

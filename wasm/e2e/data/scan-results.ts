/**
 * Canned portScan device results.
 * Format matches the Device interface from wasm/src/device-settings-wasm/types.ts.
 */
export const scannedDevices = [
  {
    device_signature: 'WB-MAP3ET',
    fw_signature: 'WB-MAP3ET',
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

import { deviceTypeGroups } from '../data/device-types';
import { scannedDevices } from '../data/scan-results';
import { deviceSchemas } from '../data/device-schemas';

/**
 * Returns a JS string that replaces module.js (the WASM binary).
 * It waits for script.js to define window.Module, then installs mock
 * implementations of the WASM-bound functions and triggers onRuntimeInitialized.
 */
export function getModuleMockScript(): string {
  const deviceTypesJSON = JSON.stringify(deviceTypeGroups);
  const scannedDevicesJSON = JSON.stringify(scannedDevices);
  const deviceSchemasJSON = JSON.stringify(deviceSchemas);

  return `
(() => {
  const DEVICE_TYPE_GROUPS = ${deviceTypesJSON};
  const SCANNED_DEVICES = ${scannedDevicesJSON};
  const DEVICE_SCHEMAS = ${deviceSchemasJSON};

  function waitFor(condFn, cb) {
    if (condFn()) { cb(); return; }
    setTimeout(() => waitFor(condFn, cb), 5);
  }

  waitFor(
    () => window.Module && window.Module.parseReply && typeof SerialPort !== 'undefined',
    () => {
      const M = window.Module;

      if (M.__mockInstalled) return;
      M.__mockInstalled = true;

      M.configGetDeviceTypes = function(json) {
        const reply = JSON.stringify({ result: DEVICE_TYPE_GROUPS });
        setTimeout(() => M.parseReply(reply), 1);
      };

      M.configGetSchema = function(json) {
        const req = JSON.parse(json);
        const schema = DEVICE_SCHEMAS[req.type] || { device: { name: req.type, parameters: [], channels: [], groups: [] } };
        const reply = JSON.stringify({ result: schema });
        setTimeout(() => M.parseReply(reply), 1);
      };

      M.portScan = function(json) {
        const req = JSON.parse(json);
        let devices = [];
        if (req.mode === 'start') {
          devices = SCANNED_DEVICES.filter(
            (d) => d.cfg.baud_rate === req.baud_rate && d.cfg.parity === req.parity
          );
        }
        const reply = JSON.stringify({ result: { devices } });
        setTimeout(() => M.parseReply(reply), 1);
      };

      M.deviceLoadConfig = function(json) {
        const req = JSON.parse(json);
        const device = SCANNED_DEVICES.find((d) => d.cfg.slave_id === req.slave_id);
        const result = device ? { parameters: { baud_rate: device.cfg.baud_rate } } : { parameters: {} };
        const reply = JSON.stringify({ result });
        setTimeout(() => M.parseReply(reply), 1);
      };

      M.deviceSet = function(json) {
        const reply = JSON.stringify({ result: { success: true } });
        setTimeout(() => M.parseReply(reply), 1);
      };

      M.onRuntimeInitialized();
    }
  );
})();
`;
}

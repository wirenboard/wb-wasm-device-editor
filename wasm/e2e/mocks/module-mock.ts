import { deviceTypeGroups, map3et } from '../data/device-types';
import { scannedDevices } from '../data/scan-results';
import { deviceSchemas } from '../data/device-schemas';
import { buildDefaultConfig } from '../data/load-template';

/**
 * Returns a JS string that replaces module.js (the WASM binary).
 * It waits for script.js to define window.Module, then installs mock
 * implementations of the WASM-bound functions and triggers onRuntimeInitialized.
 */
export function getModuleMockScript(): string {
  const deviceTypesJSON = JSON.stringify(deviceTypeGroups);
  const scannedDevicesJSON = JSON.stringify(scannedDevices);
  const deviceSchemasJSON = JSON.stringify(deviceSchemas);
  const defaultConfigJSON = JSON.stringify(buildDefaultConfig(map3et));

  return `
(() => {
  const DEVICE_TYPE_GROUPS = ${deviceTypesJSON};
  const SCANNED_DEVICES = ${scannedDevicesJSON};
  const DEVICE_SCHEMAS = ${deviceSchemasJSON};
  const DEFAULT_CONFIG = ${defaultConfigJSON};

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
        // Check if error injection is enabled
        if (window.__mockError) {
          const reply = JSON.stringify({ error: { code: -1, message: 'Mock load error' } });
          setTimeout(() => M.parseReply(reply), 1);
          return;
        }
        const device = SCANNED_DEVICES.find((d) => d.cfg.slave_id === req.slave_id);
        // Use default values from the real template for all parameters
        const parameters = Object.assign({}, DEFAULT_CONFIG);
        // Override baud_rate with the device's actual connection baud rate register value
        // (the template uses register-level values: 96=9600, 192=19200, etc.)
        if (device) {
          parameters.baud_rate = DEFAULT_CONFIG.baud_rate;
        }
        const result = { parameters };
        if (device && device.fw) {
          result.fw = device.fw.version;
          result.model = device.device_signature;
        }
        const reply = JSON.stringify({ result });
        setTimeout(() => M.parseReply(reply), 1);
      };

      M.deviceSet = function(json) {
        const req = JSON.parse(json);
        // Store the payload for test inspection
        window.__lastDeviceSetPayload = req;
        const reply = JSON.stringify({ result: { success: true } });
        setTimeout(() => M.parseReply(reply), 1);
      };

      M.onRuntimeInitialized();
    }
  );
})();
`;
}

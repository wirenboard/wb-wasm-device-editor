let wasmReadyResolve;

window.Module =
  {
      isReady: new Promise((resolve) => {
          wasmReadyResolve = resolve;
      }),

      loadingProgress: null,
      _loadingCallbacks: [],

      onLoadingProgress(callback) {
          this._loadingCallbacks.push(callback);
          if (this.loadingProgress) {
              callback(this.loadingProgress);
          }
          return () => {
              this._loadingCallbacks = this._loadingCallbacks.filter(cb => cb !== callback);
          };
      },

      _notifyLoading() {
          this._loadingCallbacks.forEach(cb => cb(this.loadingProgress));
      },

      _requestLock: Promise.resolve(),

      onRuntimeInitialized() {
          this.serial = new SerialPort();
          this.loadingProgress = { loaded: this.loadingProgress?.total || 0, total: this.loadingProgress?.total || 0, percent: 100 };
          this._notifyLoading();
          wasmReadyResolve();
      },

      async request(type, data) {
          // Serialize all RPC requests — the serial port and shared
          // finished/reply state cannot handle concurrent access.
          let unlock;
          const prev = this._requestLock;
          this._requestLock = new Promise((resolve) => { unlock = resolve; });
          await prev;

          try {
              return await this._doRequest(type, data);
          } finally {
              unlock();
          }
      },

      async _doRequest(type, data) {
          let json = JSON.stringify(data);
          this.finished = false;

          try {
              switch (type) {
                  case 'configGetDeviceTypes': this.configGetDeviceTypes(json); break;
                  case 'configGetSchema': this.configGetSchema(json); break;
                  case 'portScan': this.portScan(json); break;
                  case 'portSetup': this.portSetup(json); break;
                  case 'deviceLoadConfig': this.deviceLoadConfig(json); break;
                  case 'deviceSet': this.deviceSet(json); break;
                  case 'deviceLoad': this.deviceLoad(json); break;
                  case 'fwGetInfo': this.fwGetInfo(json); break;
                  case 'fwUpdate': this.fwUpdate(json); break;
                  case 'fwRestore': this.fwRestore(json); break;
                  case 'fwClearError': this.fwClearError(json); break;
              }
          } catch (e) {
              const msg = (e && e.message) ? e.message : String(e);
              this.print('WASM call failed for ' + type + ': ' + msg);
              return { error: { code: -1, message: 'WASM call failed: ' + msg } };
          }

          const timeout = ['fwUpdate', 'fwRestore'].includes(type) ? 600000 : 120000;
          const deadline = Date.now() + timeout;
          await new Promise((resolve) => {
              const check = () => {
                  if (this.finished || Date.now() > deadline) {
                      resolve();
                      return;
                  }
                  setTimeout(check, 1);
              };
              check();
          });

          if (!this.finished) {
              this.print('RPC request timeout (' + (timeout / 1000) + 's) for: ' + type);
              this.reply = { error: { code: -1, message: 'RPC request timeout' } };
          }

          return this.reply;
      },

      async httpGetText(url) {
          try {
              const response = await fetch(url);

              if (!response.ok)
                throw new Error(`http ${response.status} downloading ${url}`);

              const text = await response.text();
              const bytes = new TextEncoder().encode(text);
              const ptr = Module._malloc(bytes.length + 1);
              Module.HEAPU8.set(bytes, ptr);
              Module.HEAPU8[ptr + bytes.length] = 0;
              return ptr;
          } catch (e) {
              this.print('http request failed for ' + url + ': ' + e);
              return 0;
          }
      },

      async httpGetBinary(url) {
          try {
              const response = await fetch(url);

              if (!response.ok)
                throw new Error(`http ${response.status} downloading ${url}`);

              const buffer = await response.arrayBuffer();
              const data = new Uint8Array(buffer);
              const ptr = Module._malloc(4 + data.length);
              Module.HEAP32[ptr >> 2] = data.length;
              Module.HEAPU8.set(data, ptr + 4);
              return ptr;
          } catch (e) {
              this.print('http request failed for ' + url + ': ' + e);
              return 0;
          }
      },

      _fwUpdateStateCallbacks: [],

      parseString(string, fwUpdateState) {
          const json = JSON.parse(string);

          if (fwUpdateState) {
              try {
                  this._fwUpdateStateCallbacks.forEach(cb => cb(json));
              } catch (e) {
                  this.print('Failed to parse FW update state: ' + e);
              }
              return;
          }

          this.reply = json;

          if (this.reply.error)
              this.print('request error ' + this.reply.error.code + ': ' + this.reply.error.message);

          this.finished = true;
      },

      subscribeFwUpdateState(callback) {
          this._fwUpdateStateCallbacks.push(callback);
          return () => {
              this._fwUpdateStateCallbacks = this._fwUpdateStateCallbacks.filter(cb => cb !== callback);
          };
      },

      // Emscripten calls Module.setStatus(text) with a formatted string during
      // data file download, e.g. "Downloading data... (3145728/6291456)".
      // This format is hardcoded in the Emscripten-generated loader (emscripten.py
      // DataRequest), so we have to parse the string to extract loaded/total bytes.
      setStatus(text) {
          this.print(text);
          const match = text.match(/\((\d+)\/(\d+)\)/);
          if (match) {
              const loaded = parseInt(match[1], 10);
              const total = parseInt(match[2], 10);
              this.loadingProgress = { loaded, total, percent: total ? Math.round(loaded / total * 100) : 0 };
              this._notifyLoading();
          } else if (text.includes('Downloading')) {
              this.loadingProgress = { loaded: 0, total: 0, percent: 0 };
              this._notifyLoading();
          }
      },

      print(text) {
          console.log(text);
      },
  };

class PortScan {
    baudRate = [115200, 57600, 38400, 19200, 9600, 4800, 2400, 1200];
    parity = ['N', 'E', 'O'];
    step = 100 / this.baudRate.length / this.parity.length;
    progress = 0;

    constructor(callback) {
        this.callback = callback;
    }

    async request(start) {
        let request =
          {
              command: 96,
              mode: start ? 'start' : 'next',
              baud_rate: this.baudRate[this.baudRateIndex],
              data_bits: 8,
              parity: this.parity[this.parityIndex],
              stop_bits: 2,
          };

        return await Module.request('portScan', request);
    }

    async exec() {
        let devices = new Array();
        let start = true;

        this.baudRateIndex = 0;
        this.progress = 0;
        this.count = 0;

        while (this.baudRateIndex < this.baudRate.length) {
            this.parityIndex = 0;
            this.updateStatus();

            while (this.parityIndex < this.parity.length) {
                let reply = await this.request(start);

                if (reply.result?.devices?.length) {
                    reply.result.devices.forEach((device) => devices.push(device));
                    start = false;
                    continue;
                }

                this.progress += this.step;
                this.count += devices.length;
                this.parityIndex++;
                start = true;
            }

            this.baudRateIndex++;
            start = true;
        }

        this.updateStatus();
        return { devices: devices };
    }

    updateStatus() {
        if (!this.callback)
            return;

        let status = {
            progress: Math.round(this.progress),
            count: this.count
        };

        if (this.progress < 100)
            status.options = this.baudRate[this.progress ? this.baudRateIndex : 0] + ' 8' + this.parity[this.progress ? this.parityIndex : 0] + '2';

        this.callback(status);
    }
}

window.PortScan = PortScan;

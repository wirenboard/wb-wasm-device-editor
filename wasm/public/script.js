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
                  case 'portLoad': this.portLoad(json); break;
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

class ScanBase {
    baudRate = [9600, 115200, 57600, 38400, 19200, 4800, 2400, 1200];
    parity = ['N', 'E', 'O'];
    baudRateIndex = 0;
    parityIndex = 0;
    slaveId = 0;
    progress = 0;
    stopped = false;

    constructor(callback) {
        this.callback = callback;
    }

    loadCache() {
        this.cache = JSON.parse(localStorage.getItem('scanCache')) || {};
    }

    updateCache() {
        this.loadCache();

        for (let i = 0; i < this.devices.length; i++) {
            this.cache[this.devices[i].cfg.slave_id] = {
                baud_rate: this.devices[i].cfg.baud_rate,
                parity: this.devices[i].cfg.parity
            };
        }

        localStorage.setItem('scanCache', JSON.stringify(this.cache));
    }

    updateStatus() {
        if (!this.callback)
            return;

        let status = {
            progress: Math.round(this.progress),
            count: this.devices.length,
            slaveId: this.slaveId,
            type: this.type
        };

        if (this.progress < 100)
            status.options = this.baudRate[this.baudRateIndex] + ' 8' + this.parity[this.parityIndex] + '2';

        this.callback(status);
    }

    stop() {
        this.stopped = true;
    }
}

class BootScan extends ScanBase {
    async request(address, count, cfg) {
        const request = {
            protocol: 'modbus',
            baud_rate: cfg?.baud_rate ?? this.baudRate[this.baudRateIndex],
            data_bits: cfg?.data_bits ?? 8,
            parity: cfg?.parity ?? this.parity[this.parityIndex],
            stop_bits: cfg?.stop_bits ?? 2,
            slave_id: cfg?.slave_id ?? this.slaveId,
            function: 3,
            address: address,
            count: count,
            format: 'HEX'
        };
        return await Module.request('portLoad', request);
    }

    async bootMode() {
        let request = await this.request(330, 8);

        if (request.error)
            return false;

        request = await this.request(330, 7);
        return request.error ? true : false;
    }

    async readSignature() {
        const request = await this.request(290, 12);
        return this.parseString(request.result?.response);
    }

    async readDeviceInfo(cfg) {
        const signature = await this.request(200, 20, cfg);

        if (signature.error)
            return null;

        const version = await this.request(250, 16, cfg);
        return {
            device_signature: this.parseString(signature.result?.response),
            fw: { version: this.parseString(version.result?.response) },
            cfg: cfg
        };
    }

    async deviceData(slaveId) {
        return {
            slave_id: slaveId ?? this.slaveId,
            bootloader_mode: true,
            cfg: {
                slave_id: this.slaveId,
                baud_rate: this.baudRate[this.baudRateIndex],
                parity: this.parity[this.parityIndex],
                data_bits: 8,
                stop_bits: 2
            },
            fw_signature: await this.readSignature()
        };
    }

    async findDevice(cfg) {
        const result = await this.readDeviceInfo(cfg);

        if (result)
            return result;

        for (let i = 0; i < this.baudRate.length; i++) {
            for (let j = 0; j < this.parity.length; j++) {
                if (this.baudRate[i] != cfg.baud_rate || this.parity[j] != cfg.parity) {
                    const result = await this.readDeviceInfo({ ...cfg, baud_rate: this.baudRate[i], parity: this.parity[j] });
                    if (result)
                        return result;
                }
            }
        }

        throw new Error('Device not responding after firmware restore');
    }

    async broadcastScan() {
        const step = 100 / this.baudRate.length / this.parity.length;

        this.type = 'broadcast';
        this.baudRateIndex = 0;
        this.progress = 0;
        this.slaveId = 0;
        this.stopped = false;

        while (this.baudRateIndex < this.baudRate.length && !this.stopped) {
            this.parityIndex = 0;

            while (this.parityIndex < this.parity.length && !this.stopped) {
                this.updateStatus();
                this.progress += step;

                if (await this.bootMode()) {
                    this.devices.push(await this.deviceData(0));
                    this.updateStatus();
                    return;
                }

                this.parityIndex++;
            }

            this.baudRateIndex++;
        }
    }

    async cacheScan() {
        const items = Object.entries(this.cache);

        if (!items.length)
            return;

        const step = 100 / items.length;

        this.type = 'cache';
        this.progress = 0;
        this.stopped = false;

        for (const [slaveId, cfg] of items) {
            if (this.stopped)
                break;

            this.baudRateIndex = this.baudRate.indexOf(cfg.baud_rate);
            this.parityIndex = this.parity.indexOf(cfg.parity);
            this.slaveId = Number(slaveId);

            this.updateStatus();
            this.progress += step;

            if (await this.bootMode()) {
                this.devices.push(await this.deviceData());
                continue;
            }

            if (cfg.baud_rate == 9600 && cfg.parity == 'N')
                continue;

            this.baudRateIndex = 0;
            this.parityIndex = 0;

            if (!(await this.bootMode()))
                continue;

            this.devices.push(await this.deviceData());
        }

        this.updateStatus();
    }

    async fullScan() {
        let maxSlaveId = 247;
        let step = 100 / this.baudRate.length / this.parity.length / maxSlaveId;

        this.type = 'full';
        this.baudRateIndex = 0;
        this.progress = 0;
        this.stopped = false;

        while (this.baudRateIndex < this.baudRate.length && !this.stopped) {
            this.parityIndex = 0;

            while (this.parityIndex < this.parity.length && !this.stopped) {
                for (this.slaveId = 1; this.slaveId <= maxSlaveId && !this.stopped; this.slaveId++) {
                    this.updateStatus();
                    this.progress += step;

                    if (this.devices.some(d => d.slave_id === this.slaveId))
                        continue;

                    if (!(await this.bootMode()))
                        continue;

                    this.devices.push(await this.deviceData());
                }

                this.parityIndex++;
            }

            this.baudRateIndex++;
        }

        this.updateStatus();
    }

    async exec() {
        this.loadCache();
        this.devices = new Array();

        await this.broadcastScan();

        if (this.devices.length)
            return { devices: this.devices };

        if (!this.stopped)
            await this.cacheScan();

        if (!this.stopped)
            await this.fullScan();

        return { devices: this.devices };
    }

    parseString(hex) {
        let result = '';

        for (let i = 0; i < hex.length; i += 4) {
            const reg = parseInt(hex.substring(i, i + 4), 16) & 0xFF;

            if (!reg)
                break;

            result += String.fromCharCode(reg);
        }

        return result;
    }
}

class PortScan extends ScanBase {
    async request(start) {
        let request = {
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
        let step = 100 / this.baudRate.length / this.parity.length;
        let start = true;

        this.devices = new Array();
        this.baudRateIndex = 0;
        this.progress = 0;
        this.stopped = false;

        while (this.baudRateIndex < this.baudRate.length && !this.stopped) {
            this.parityIndex = 0;

            while (this.parityIndex < this.parity.length && !this.stopped) {
                this.updateStatus();
                let reply = await this.request(start);

                if (reply.result?.devices?.length) {
                    reply.result.devices.forEach((device) => this.devices.push(device));
                    start = false;
                    continue;
                }

                this.parityIndex++;
                this.progress += step;
                start = true;
            }

            this.baudRateIndex++;
            start = true;
        }

        this.updateCache();
        this.updateStatus();

        return { devices: this.devices };
    }
}

window.BootScan = BootScan;
window.PortScan = PortScan;

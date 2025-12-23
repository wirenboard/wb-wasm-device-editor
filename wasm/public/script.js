let wasmReadyResolve;

window.Module =
  {
      serial: new SerialPort(),
      ready: false,

      isReady: new Promise((resolve) => {
          wasmReadyResolve = resolve;
      }),

      onRuntimeInitialized() {
          wasmReadyResolve();
      },

      async request(type, data) {
          let json = JSON.stringify(data);

          function wait(resolve) {
              if (this.finished) {
                  resolve();
                  return;
              }

              setTimeout(wait.bind(this, resolve), 1);
          }

          this.finished = false;

          switch (type) {
              case 'configGetDeviceTypes': this.configGetDeviceTypes(json); break;
              case 'configGetSchema': this.configGetSchema(json); break;
              case 'portScan': this.portScan(json); break;
              case 'deviceLoadConfig': this.deviceLoadConfig(json); break;
              case 'deviceSet': this.deviceSet(json); break;
          }

          await new Promise(wait.bind(this));
          return this.reply;
      },

      parseReply(reply) {
          this.reply = JSON.parse(reply);

          if (this.reply.error)
              this.print('request error ' + this.reply.error.code + ': ' + this.reply.error.message);

          this.finished = true;
      },

      setStatus(text) {
          this.print(text);
      },

      print(text) {
          console.log(text);
      },
  };

class PortScan {
    baudRate = [115200, 57600, 38400, 19200, 9600, 4800, 2400, 1200];
    parity = ['N', 'E', 'O'];
    step = 100 / this.baudRate.length / this.parity.length;

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

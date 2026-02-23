class SerialPort {
    filters =
      [
          { usbVendorId: 0x0403, usbProductId: 0x6001 },
          { usbVendorId: 0x0403, usbProductId: 0x6014 },
          { usbVendorId: 0x0403, usbProductId: 0x6015 },
          { usbVendorId: 0x04d9, usbProductId: 0xb534 },
          { usbVendorId: 0x10c4, usbProductId: 0xea60 },
          { usbVendorId: 0x10c4, usbProductId: 0xea61 },
          { usbVendorId: 0x10c4, usbProductId: 0xea63 },
          { usbVendorId: 0x1a86, usbProductId: 0x55d3 },
          { usbVendorId: 0x1a86, usbProductId: 0x7522 },
          { usbVendorId: 0x1a86, usbProductId: 0x7523 },
      ];

    chipNames = {
        '1027:24577': 'FTDI FT232',
        '1027:24596': 'FTDI FT232H',
        '1027:24597': 'FTDI FT2232H',
        '1241:46388': 'Holtek HT42B534',
        '4292:60000': 'CP2102',
        '4292:60001': 'CP2102N',
        '4292:60003': 'CP2104',
        '6790:21971': 'CH343',
        '6790:30002': 'CH340',
        '6790:30003': 'CH341',
    };

    options = new Object();
    isOpen = false;

    constructor() {
        if (navigator.serial)
            return;

        alert('Web Serial API is not supported by this browser :(\n\nIt\'s currently supported by Chrome/Chromium, Edge and Opera browsers.');
    }

    setOptions(baudRate, dataBits, parity, stopBits) {
        switch (true) {
            case baudRate < 4800: this.replyTimeout = 1000; break;
            case baudRate < 38400: this.replyTimeout = 500; break;
            default: this.replyTimeout = 250; break;
        }

        switch (String.fromCharCode(parity)) {
            case 'E': this.options.parity = 'even'; break;
            case 'O': this.options.parity = 'odd'; break;
            default: this.options.parity = 'none'; break;
        }

        this.options.baudRate = baudRate;
        this.options.dataBits = dataBits;
        this.options.stopBits = stopBits;
    }

    _portKey(info) {
        return info.usbVendorId + ':' + info.usbProductId;
    }

    _portHexId(info) {
        const vid = info.usbVendorId?.toString(16).padStart(4, '0') ?? '????';
        const pid = info.usbProductId?.toString(16).padStart(4, '0') ?? '????';
        return vid + ':' + pid;
    }

    _getMatchingPorts(granted) {
        return granted.filter(p => {
            const info = p.getInfo();
            return this.filters.some(f =>
                f.usbVendorId === info.usbVendorId &&
                f.usbProductId === info.usbProductId
            );
        });
    }

    async tryAutoSelect() {
        if (this.port) return;
        const granted = await navigator.serial.getPorts();
        const matching = this._getMatchingPorts(granted);
        if (matching.length === 1) {
            this.port = matching[0];
            localStorage.setItem('serialPort', this._portKey(this.port.getInfo()));
        } else if (matching.length > 1) {
            const saved = localStorage.getItem('serialPort');
            if (saved) {
                const found = matching.find(p => this._portKey(p.getInfo()) === saved);
                if (found) this.port = found;
            }
        }
    }

    async getPortInfo() {
        await this.tryAutoSelect();
        const granted = await navigator.serial.getPorts();
        const matching = this._getMatchingPorts(granted);
        let name = null;
        let hexId = null;
        if (this.port) {
            const idx = matching.indexOf(this.port);
            name = 'Port ' + (idx >= 0 ? idx + 1 : 1);
            hexId = this._portHexId(this.port.getInfo());
        }
        return { name, hexId, matchingCount: matching.length };
    }

    async forceSelect() {
        this.port = await navigator.serial.requestPort({ filters: this.filters });
        localStorage.setItem('serialPort', this._portKey(this.port.getInfo()));
    }

    async select(force) {
        if (this.port && !force)
            return;

        // Try to auto-select from already-granted ports
        const granted = await navigator.serial.getPorts();
        const matching = this._getMatchingPorts(granted);

        if (matching.length === 1) {
            this.port = matching[0];
            localStorage.setItem('serialPort', this._portKey(this.port.getInfo()));
            return;
        }

        // Multiple matches — try to use the last selected port
        if (matching.length > 1) {
            const saved = localStorage.getItem('serialPort');
            if (saved) {
                const found = matching.find(p => this._portKey(p.getInfo()) === saved);
                if (found) {
                    this.port = found;
                    return;
                }
            }
        }

        // Fall back to chooser dialog (needs user gesture)
        this.port = await navigator.serial.requestPort({ filters: this.filters });
        localStorage.setItem('serialPort', this._portKey(this.port.getInfo()));
    }

    async open() {
        if (this.isOpen)
            await this.close();

        for (let i = 0; i < 100; i++) {
            try {
                await this.select(false);
                await this.port.open(this.options);
                this.isOpen = true;
            } catch (error) {
                this.error = error;
                await new Promise((resolve) => setTimeout(resolve, 1));
                continue;
            }

            return;
        }

        console.error('Can\'t open serial port: ', this.error);
        delete this.port;
    }

    async close() {
        if (!this.port || !this.isOpen)
            return;

        try {
            await this.port.close();
        } catch (_) {}
        this.isOpen = false;
    }

    async write(data) {
        await this.open();

        if (!this.port || !this.port.writable) {
            console.error('Serial port is not open or not writable');
            return;
        }

        const writer = this.port.writable.getWriter();
        await writer.write(data);
        writer.releaseLock();
    }

    async read(count) {
        if (!this.port || !this.port.readable) {
            console.error('Serial port is not open or not readable');
            return;
        }

        const reader = this.port.readable.getReader();
        let data = new Uint8Array();
        let read = true;

        async function receive() {
            while (read) {
                let { value } = await reader.read();

                if (!read)
                    break;

                let buffer = new Uint8Array(data.length + value.length);
                buffer.set(data, 0);
                buffer.set(value, data.length);
                data = buffer;

                if (data.length < count)
                    continue;

                read = false;
            }

            return data;
        }

        async function wait(timeout) {
            await new Promise((resolve) => setTimeout(resolve, timeout));

            if (read) {
                read = false;
                await reader.cancel();
            }

            return data;
        }

        let result = await Promise.race([receive(), wait(this.replyTimeout)]);
        try { reader.releaseLock(); } catch (_) {}
        return result;
    }
}

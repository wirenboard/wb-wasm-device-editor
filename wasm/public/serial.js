class SerialPort {
    filters =
      [
          { usbVendorId: 0x0403, usbProductId: 0x1235 },
          { usbVendorId: 0x0403, usbProductId: 0x6001 },
          { usbVendorId: 0x0403, usbProductId: 0x6010 },
          { usbVendorId: 0x0403, usbProductId: 0x6011 },
          { usbVendorId: 0x0403, usbProductId: 0x6014 },
          { usbVendorId: 0x0403, usbProductId: 0x6015 },
          { usbVendorId: 0x04d8, usbProductId: 0x00dd },
          { usbVendorId: 0x04d8, usbProductId: 0x00df },
          { usbVendorId: 0x04d9, usbProductId: 0xb534 },
          { usbVendorId: 0x04e2, usbProductId: 0x1411 },
          { usbVendorId: 0x067b, usbProductId: 0x2303 },
          { usbVendorId: 0x067b, usbProductId: 0x23a3 },
          { usbVendorId: 0x10c4, usbProductId: 0xea60 },
          { usbVendorId: 0x10c4, usbProductId: 0xea61 },
          { usbVendorId: 0x10c4, usbProductId: 0xea63 },
          { usbVendorId: 0x10c4, usbProductId: 0xea71 },
          { usbVendorId: 0x1a86, usbProductId: 0x55d2 },
          { usbVendorId: 0x1a86, usbProductId: 0x55d3 },
          { usbVendorId: 0x1a86, usbProductId: 0x55d4 },
          { usbVendorId: 0x1a86, usbProductId: 0x7522 },
          { usbVendorId: 0x1a86, usbProductId: 0x7523 }
      ];

    options = new Object();
    isOpen = false;
    api = null;

    async init() {
        if (navigator.serial) {
            this.api = navigator.serial;
            console.log('Using native WebSerial API');
            return;
        }

        if (!navigator.usb) {
            alert('WebSerial API and WebUSB API is not supported by this browser :(\n\nIt\'s currently supported by Chrome/Chromium, Edge and Opera browsers.');
            console.error('WebSerial API and WebUSB API is not available');
            return;
        }

        try {
            const { serial } = await import('/vendor/web-serial-polyfill.js');
            this.api = serial;
            console.log('WebSerial API is not available, using WebUSB API polyfill');
            return;
        } catch (e) {
            console.error('Failed to load WebUSB API polyfill:', e);
        }
    }

    checkSerial(method) {
        if (this.api) return;
        console.error(method + '() called but API is null');
        console.error('userAgent: ' + navigator.userAgent);
        console.error('isSecureContext: ' + window.isSecureContext);
        console.error('navigator.serial: ' + typeof navigator.serial);
        console.error('navigator.usb: ' + typeof navigator.usb);
        throw new Error('WebSerial API and WebUSB API is not available, try to refresh page or open it in incognito mode.');
    }

    setExtendedTimeout(enabled) {
        this.extendedTimeout = enabled;
    }

    setOptions(baudRate, dataBits, parity, stopBits) {
        switch (true) {
            case baudRate < 4800: this.replyTimeout = 1000; break;
            case baudRate < 38400: this.replyTimeout = 500; break;
            default: this.replyTimeout = 250; break;
        }

        let parityName;
        switch (String.fromCharCode(parity)) {
            case 'E': parityName = 'even'; break;
            case 'O': parityName = 'odd'; break;
            default: parityName = 'none'; break;
        }

        if (this.extendedTimeout)
            this.replyTimeout *= 2;

        // The port is reopened to take new settings; a request that restates
        // the settings already in force must not pay for that.
        if (this.options.baudRate !== baudRate || this.options.dataBits !== dataBits ||
            this.options.parity !== parityName || this.options.stopBits !== stopBits) {
            this.optionsChanged = true;
        }
        this.options.parity = parityName;
        this.options.baudRate = baudRate;
        this.options.dataBits = dataBits;
        this.options.stopBits = stopBits;
    }

    portKey(info) {
        return info.usbVendorId + ':' + info.usbProductId;
    }

    getMatchingPorts(granted) {
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
        this.checkSerial('tryAutoSelect');
        const granted = await this.api.getPorts();
        const matching = this.getMatchingPorts(granted);
        if (matching.length === 1) {
            this.port = matching[0];
            localStorage.setItem('serialPort', this.portKey(this.port.getInfo()));
        } else if (matching.length > 1) {
            const saved = localStorage.getItem('serialPort');
            if (saved) {
                const found = matching.find(p => this.portKey(p.getInfo()) === saved);
                if (found) this.port = found;
            }
        }
    }

    async getPortInfo() {
        await this.tryAutoSelect();
        const granted = await this.api.getPorts();
        const matching = this.getMatchingPorts(granted);
        let name = null;
        if (this.port) {
            const idx = matching.indexOf(this.port);
            name = 'Port ' + (idx >= 0 ? idx + 1 : 1);
        }
        return { name, matchingCount: matching.length };
    }

    async forceSelect() {
        this.checkSerial('forceSelect');
        // The open port belongs to the previous selection; without this the
        // swapped-in port is never opened (writes used to reopen every time).
        await this.close();
        this.pending = new Uint8Array();
        this.port = await this.api.requestPort({ filters: this.filters });
        localStorage.setItem('serialPort', this.portKey(this.port.getInfo()));
    }

    async select(force) {
        if (this.port && !force)
            return;

        this.checkSerial('select');

        // Try to auto-select from already-granted ports
        const granted = await this.api.getPorts();
        const matching = this.getMatchingPorts(granted);

        if (matching.length === 1) {
            this.port = matching[0];
            localStorage.setItem('serialPort', this.portKey(this.port.getInfo()));
            return;
        }

        // Multiple matches — try to use the last selected port
        if (matching.length > 1) {
            const saved = localStorage.getItem('serialPort');
            if (saved) {
                const found = matching.find(p => this.portKey(p.getInfo()) === saved);
                if (found) {
                    this.port = found;
                    return;
                }
            }
        }

        // Fall back to chooser dialog (needs user gesture)
        this.port = await this.api.requestPort({ filters: this.filters });
        localStorage.setItem('serialPort', this.portKey(this.port.getInfo()));
    }

    async open() {
        if (this.isOpen)
            await this.close();
        this.pending = new Uint8Array();
        this.optionsChanged = false;

        for (let i = 0; i < 100; i++) {
            try {
                await this.select(false);
                await this.port.open({ ...this.options, resetUsb: true });
                this.isOpen = true;
            } catch (error) {
                this.error = error;
                // No port chosen, or the chooser needs a user gesture we do
                // not have — retrying only spams requestPort a hundred times.
                if (error instanceof DOMException
                    && ['NotFoundError', 'SecurityError', 'NotAllowedError'].includes(error.name)) {
                    delete this.port;
                    return;
                }
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
        } catch (e) {
            console.warn('Serial port close error:', e);
        }
        this.isOpen = false;
    }

    async write(data) {
        // Closing and reopening the USB port on every write cost tens of
        // milliseconds per Modbus exchange; the port stays open until the line
        // settings change or a request fails.
        if (!this.isOpen || this.optionsChanged || !this.port || !this.port.writable)
            await this.open();

        if (!this.port || !this.port.writable) {
            console.error('Serial port is not open or not writable');
            this.isOpen = false;
            return;
        }

        try {
            const writer = this.port.writable.getWriter();
            await writer.write(data);
            writer.releaseLock();
        } catch (error) {
            // A dead stream: the adapter was unplugged or Chrome errored the
            // port. Mark it closed so the next request reopens and heals —
            // the old reopen-on-every-write policy did this by accident.
            console.warn('Serial write failed, will reopen:', error);
            this.isOpen = false;
            throw error;
        }
    }

    /**
     * Whatever bytes arrive within timeoutMs, at most count of them; an empty
     * array when nothing does. Bytes beyond count stay queued for the next
     * call, so a frame the port delivers in one chunk is not lost when the
     * caller asks for it in pieces.
     */
    async readChunk(count, timeoutMs) {
        if (this.pending && this.pending.length) {
            return this.takePending(count);
        }
        if (!this.port || !this.port.readable) {
            console.error('Serial port is not open or not readable');
            this.isOpen = false;
            return new Uint8Array();
        }
        // Firmware flows ask for extra patience around bootloader operations;
        // honour it here since the module's own timeouts no longer go through
        // the old read() path.
        if (this.extendedTimeout)
            timeoutMs = Math.max(timeoutMs, this.replyTimeout);

        const reader = this.port.readable.getReader();
        let timer;
        let timedOut = false;
        const timeout = new Promise((resolve) => {
            timer = setTimeout(() => { timedOut = true; resolve(); }, timeoutMs);
        });
        let value;
        try {
            const read = reader.read();
            await Promise.race([read, timeout]);
            if (timedOut) {
                // Cancelling settles the pending read with done=true. It has to
                // be awaited before the lock is released, or the next reader
                // is handed the closing stream and reads nothing at all.
                await reader.cancel().catch(() => {});
            }
            ({ value } = await read);
        } catch (error) {
            console.warn('Serial read error:', error);
            value = undefined;
        } finally {
            clearTimeout(timer);
            try { reader.releaseLock(); } catch {}
        }
        if (!value || !value.length) {
            return new Uint8Array();
        }
        this.pending = value;
        return this.takePending(count);
    }

    takePending(count) {
        const taken = this.pending.slice(0, count);
        this.pending = this.pending.slice(taken.length);
        return taken;
    }

    /** Drop what has arrived but nobody asked for — a late reply to a request that already timed out. */
    async discardPending() {
        this.pending = new Uint8Array();
        if (!this.port || !this.port.readable)
            return;
        // A zero-length wait would race the port; a few milliseconds is enough
        // to collect what the adapter already holds.
        // Bounded: a noisy line, or a second master polling the same bus,
        // delivers bytes continuously, and an unbounded drain would hold the
        // whole request pipeline hostage.
        const deadline = performance.now() + 100;
        while ((await this.readChunk(4096, 5)).length) {
            if (performance.now() > deadline) {
                console.warn('Serial drain gave up: the line keeps delivering data');
                break;
            }
        }
        this.pending = new Uint8Array();
    }

    /** Read up to count bytes within the reply timeout — the pre-chunked contract, kept for older module builds. */
    async read(count) {
        const deadline = performance.now() + this.replyTimeout;
        let data = new Uint8Array();
        while (data.length < count) {
            const left = deadline - performance.now();
            if (left <= 0)
                break;
            const chunk = await this.readChunk(count - data.length, left);
            if (!chunk.length)
                break;
            const joined = new Uint8Array(data.length + chunk.length);
            joined.set(data, 0);
            joined.set(chunk, data.length);
            data = joined;
        }
        return data;
    }
}

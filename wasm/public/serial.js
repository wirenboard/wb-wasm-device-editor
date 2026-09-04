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
    reader = null;
    writer = null;
    inflight = null;
    pending = new Uint8Array();

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

        if (this.options.baudRate !== baudRate || this.options.dataBits !== dataBits ||
            this.options.parity !== parityName || this.options.stopBits !== stopBits)
            this.optionsChanged = true;

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
        await this.close();
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

    // A USB call that never returns would suspend the C++ caller for good
    async settled(promise, timeout) {
        let timer;
        const guard = new Promise((resolve) => { timer = setTimeout(() => resolve(false), timeout); });

        try {
            return await Promise.race([promise.then(() => true, () => true), guard]);
        } finally {
            clearTimeout(timer);
        }
    }

    // One task turn without a timer: Chrome clamps timers in a hidden tab to 1 s
    tick() {
        return new Promise((resolve) => {
            const channel = new MessageChannel();
            channel.port1.onmessage = () => { channel.port1.close(); resolve(); };
            channel.port2.postMessage(0);
        });
    }

    async releaseStreams() {
        const reader = this.reader;
        this.reader = null;
        this.inflight = null;

        if (reader) {
            await this.settled(reader.cancel(), 200);
            try { reader.releaseLock(); } catch {}
        }

        const writer = this.writer;
        this.writer = null;

        if (writer) {
            await this.settled(writer.abort(), 1000);
            try { writer.releaseLock(); } catch {}
        }
    }

    async open() {
        // Failure paths clear isOpen without closing, and Chrome then rejects open() forever
        if (this.port) {
            await this.releaseStreams();
            await this.settled(this.port.close(), 1000);
        }

        this.isOpen = false;
        this.optionsChanged = false;
        this.pending = new Uint8Array();

        if (!this.api) {
            delete this.port;
            return;
        }

        for (let i = 0; i < 100; i++) {
            try {
                await this.select(false);
                await this.port.open({ ...this.options, resetUsb: true });
                this.isOpen = true;
            } catch (error) {
                this.error = error;
                // Terminal: no port, or the chooser needs a user gesture we don't have
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

        await this.releaseStreams();

        if (!(await this.settled(this.port.close(), 1000)))
            console.warn('Serial port close did not finish in time');

        this.isOpen = false;
    }

    // Asyncify.handleAsync attaches no catch: a rejection suspends the C++ call for good
    async write(data) {
        try {
            await this.writeData(data);
        } catch (error) {
            console.warn('Serial write failed:', error);
            this.isOpen = false;
        }
    }

    async writeData(data) {
        if (!this.isOpen || this.optionsChanged || !this.port || !this.port.writable)
            await this.open();

        if (!this.port || !this.port.writable) {
            console.error('Serial port is not open or not writable');
            this.isOpen = false;
            return;
        }

        // Drop the tail of an answer nobody took: it sits in the port's stream, not in pending
        await this.discardPending();

        let writer;

        try {
            writer = this.port.writable.getWriter();
        } catch (error) {
            console.warn('Serial write: stream is locked, will reopen:', error);
            this.isOpen = false;
            return;
        }

        this.writer = writer;

        try {
            await writer.write(data);
        } catch (error) {
            console.warn('Serial write error, will reopen:', error);
            this.isOpen = false;
        } finally {
            this.writer = null;
            try { writer.releaseLock(); } catch {}
        }
    }

    // At most count bytes; whatever is left stays queued for the next call
    async readChunk(count, timeout) {
        try {
            return await this.readChunkData(count, timeout);
        } catch (error) {
            console.warn('Serial readChunk failed:', error);
            this.isOpen = false;
            return new Uint8Array();
        }
    }

    async readChunkData(count, timeout) {
        if (this.pending.length)
            return this.takePending(count);

        if (!this.port || !this.port.readable) {
            console.error('Serial port is not open or not readable');
            this.isOpen = false;
            return new Uint8Array();
        }

        if (this.extendedTimeout)
            timeout = Math.max(timeout, this.replyTimeout);

        const reader = this.acquireReader();

        if (!reader)
            return new Uint8Array();

        await this.awaitRead(this.startRead(reader), timeout);
        return this.takePending(count);
    }

    acquireReader() {
        if (this.reader)
            return this.reader;

        if (!this.port || !this.port.readable)
            return null;

        try {
            this.reader = this.port.readable.getReader();
        } catch (error) {
            console.warn('Serial read: stream is locked, will reopen:', error);
            this.isOpen = false;
            return null;
        }

        return this.reader;
    }

    // One read() outstanding: its bytes land in pending even if the caller gave up
    startRead(reader) {
        if (this.inflight)
            return this.inflight;

        const record = { settled: false };

        record.promise = reader.read().then(
            ({ value, done }) => {
                record.settled = true;

                // A reader swapped out under us belongs to a port that is gone
                if (this.reader !== reader)
                    return;

                this.inflight = null;

                if (value && value.length)
                    this.appendPending(value);

                if (done)
                    this.dropReader();
            },
            (error) => {
                record.settled = true;

                if (this.reader !== reader)
                    return;

                this.inflight = null;
                console.warn('Serial read error:', error);
                this.dropReader();
            });

        this.inflight = record;
        return record;
    }

    async awaitRead(record, timeout) {
        if (record.settled)
            return;

        let timer;
        const guard = new Promise((resolve) => { timer = setTimeout(resolve, timeout); });

        try {
            await Promise.race([record.promise, guard]);
        } finally {
            clearTimeout(timer);
        }
    }

    dropReader() {
        const reader = this.reader;
        this.reader = null;
        this.inflight = null;
        this.isOpen = false;

        if (reader) {
            try { reader.releaseLock(); } catch {}
        }
    }

    appendPending(value) {
        if (!this.pending.length) {
            this.pending = value;
            return;
        }

        const joined = new Uint8Array(this.pending.length + value.length);
        joined.set(this.pending, 0);
        joined.set(value, this.pending.length);
        this.pending = joined;
    }

    takePending(count) {
        const taken = this.pending.slice(0, count);
        this.pending = this.pending.slice(taken.length);
        return taken;
    }

    async discardPending() {
        try {
            await this.drain();
        } catch (error) {
            console.warn('Serial discardPending failed:', error);
        }

        this.pending = new Uint8Array();
    }

    async drain() {
        // Bounded: a noisy line delivers bytes without end
        const deadline = performance.now() + 100;

        while (this.isOpen) {
            const reader = this.acquireReader();

            if (!reader)
                break;

            const record = this.startRead(reader);
            await this.tick();

            if (!record.settled)
                await this.tick();

            if (!record.settled)
                break;

            this.pending = new Uint8Array();

            if (performance.now() > deadline) {
                console.warn('Serial drain gave up: the line keeps delivering data');
                break;
            }
        }
    }
}

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
        try {
            this.applyOptions(baudRate, dataBits, parity, stopBits);
        } catch (error) {
            // Called straight from EM_ASM: a throw here tears down the C++ stack.
            console.warn('Serial setOptions failed:', error);
        }
    }

    applyOptions(baudRate, dataBits, parity, stopBits) {
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

    /** True if the promise settled in time — a USB call that never returns suspends the C++ caller for good. */
    async settled(promise, timeoutMs) {
        let timer;
        const guard = new Promise((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs); });
        try {
            return await Promise.race([promise.then(() => true, () => true), guard]);
        } finally {
            clearTimeout(timer);
        }
    }

    /** One task turn without a timer: Chrome clamps every timer in a hidden
     *  tab to 1 s, and a drain must not pay that. */
    tick() {
        return new Promise((resolve) => {
            const channel = new MessageChannel();
            channel.port1.onmessage = () => { channel.port1.close(); resolve(); };
            channel.port2.postMessage(0);
        });
    }

    /** Give back a reader/writer a failed request left behind: close() hangs while a stream is locked. */
    async releaseStreams() {
        const reader = this.reader;
        this.reader = null;
        this.inflight = null;
        if (reader) {
            // Bounded, then abandoned: the lock goes back either way, and a
            // cancel that never returns must not suspend the C++ caller.
            await this.settled(reader.cancel(), 200);
            try {
                reader.releaseLock();
            } catch (releaseError) {
            }
        }

        const writer = this.writer;
        this.writer = null;
        if (writer) {
            await this.settled(writer.abort(), 1000);
            try {
                writer.releaseLock();
            } catch (releaseError) {
            }
        }
    }

    async open() {
        try {
            await this.openPort();
        } catch (error) {
            // Never reject: Asyncify.handleAsync attaches no catch, so a
            // rejection would suspend the C++ call for good.
            console.warn('Serial open failed:', error);
            this.isOpen = false;
        }
    }

    async openPort() {
        // Close on the object, not on `isOpen`: failure paths mark the port
        // closed without closing it, and Chrome then rejects open() forever.
        if (this.port) {
            await this.releaseStreams();
            // Already closed, never opened, or wedged by a foreign lock: the
            // retry loop below deals with a port that would not close.
            await this.settled(this.port.close(), 1000);
        }
        this.isOpen = false;
        if (!this.api) {
            // No WebSerial/WebUSB in this browser: retrying cannot conjure a
            // port, and the 100-attempt loop below turned every request into
            // a 150 ms stall — thousands of them per device load.
            delete this.port;
            return;
        }
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
        try {
            if (!this.port || !this.isOpen)
                return;

            await this.releaseStreams();
            if (!(await this.settled(this.port.close(), 1000)))
                console.warn('Serial port close did not finish in time');
            this.isOpen = false;
        } catch (error) {
            console.warn('Serial close failed:', error);
            this.isOpen = false;
        }
    }

    async write(data) {
        try {
            await this.writeData(data);
        } catch (error) {
            // Never reject: Asyncify.handleAsync attaches no catch, so a
            // rejection would suspend the C++ call for good.
            console.warn('Serial write failed:', error);
            this.isOpen = false;
        }
    }

    async writeData(data) {
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

        let writer;
        try {
            writer = this.port.writable.getWriter();
        } catch (lockError) {
            // A writer outlived a failed request: reopening drops the lock.
            console.warn('Serial write: stream is locked, will reopen:', lockError);
            this.isOpen = false;
            return;
        }

        this.writer = writer;
        try {
            await writer.write(data);
        } catch (error) {
            // Dead stream (unplug, errored port): mark it closed, the next
            // request reopens.
            console.warn('Serial write error, will reopen:', error);
            this.isOpen = false;
        } finally {
            this.writer = null;
            // close() rejects while the stream is locked, so always release.
            try {
                writer.releaseLock();
            } catch (releaseError) {
                // The stream is already gone; the reopen path handles it.
            }
        }
    }

    /**
     * Whatever bytes arrive within timeoutMs, at most count of them; an empty
     * array when nothing does. Bytes beyond count stay queued for the next
     * call, so a frame the port delivers in one chunk is not lost when the
     * caller asks for it in pieces.
     */
    async readChunk(count, timeoutMs) {
        // On the unwind pass Asyncify.handleAsync hands the C++ caller back the
        // PREVIOUS reply, which ReadChunk then copies into a buffer sized for
        // this one — a heap overflow whenever the previous chunk was longer.
        if (typeof Asyncify !== 'undefined')
            Asyncify.handleSleepReturnValue = 0;

        try {
            return await this.readChunkData(count, timeoutMs);
        } catch (error) {
            // Never reject: Asyncify.handleAsync attaches no catch, so a
            // rejection would suspend the C++ call for good.
            console.warn('Serial readChunk failed:', error);
            this.isOpen = false;
            return new Uint8Array();
        }
    }

    async readChunkData(count, timeoutMs) {
        if (this.pending.length) {
            return this.takePending(count);
        }
        if (!this.port || !this.port.readable) {
            console.error('Serial port is not open or not readable');
            this.isOpen = false;
            return new Uint8Array();
        }
        // Firmware flows ask for extra patience. Every readChunk waits for a
        // reply now — the drain no longer goes through here at all.
        if (this.extendedTimeout)
            timeoutMs = Math.max(timeoutMs, this.replyTimeout);

        const reader = this.acquireReader();
        if (!reader)
            return new Uint8Array();
        await this.awaitRead(this.startRead(reader), timeoutMs);
        return this.takePending(count);
    }

    /** The one reader an open port gets. A reader per call meant a cancel()
     *  per timeout, which throws away bytes the next frame still needs. */
    acquireReader() {
        if (this.reader)
            return this.reader;
        if (!this.port || !this.port.readable)
            return null;
        try {
            this.reader = this.port.readable.getReader();
        } catch (lockError) {
            // A reader outlived a failed request: reopening drops the lock.
            console.warn('Serial readChunk: stream is locked, will reopen:', lockError);
            this.isOpen = false;
            return null;
        }
        return this.reader;
    }

    /** Keep one read() outstanding. Its bytes land in pending even when the
     *  caller that started it has already given up, so none are lost. */
    startRead(reader) {
        if (this.inflight)
            return this.inflight;
        const record = { settled: false };
        // A reader swapped out under us belongs to a port that is gone: its
        // bytes must not land in the buffer of the one that replaced it.
        record.promise = reader.read().then(
            ({ value, done }) => {
                record.settled = true;
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
                // Unplugged, or the lock went away: the next request reopens.
                console.warn('Serial read error:', error);
                this.dropReader();
            });
        this.inflight = record;
        return record;
    }

    /** Wait for the read, or stop waiting: an abandoned read stays in flight
     *  and delivers into pending, so the next call still gets those bytes. */
    async awaitRead(record, timeoutMs) {
        if (record.settled)
            return;
        let timer;
        const guard = new Promise((resolve) => { timer = setTimeout(resolve, timeoutMs); });
        try {
            await Promise.race([record.promise, guard]);
        } finally {
            clearTimeout(timer);
        }
    }

    /** Let go of a reader whose stream is finished; the next request reopens. */
    dropReader() {
        const reader = this.reader;
        this.reader = null;
        this.inflight = null;
        this.isOpen = false;
        if (!reader)
            return;
        try {
            reader.releaseLock();
        } catch (releaseError) {
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

    /** Drop what has arrived but nobody asked for — a late reply to a request that already timed out. */
    async discardPending() {
        try {
            await this.drain();
        } catch (error) {
            // Never reject: Asyncify.handleAsync attaches no catch, so a
            // rejection would suspend the C++ call for good.
            console.warn('Serial discardPending failed:', error);
            this.pending = new Uint8Array();
        }
    }

    async drain() {
        this.pending = new Uint8Array();
        // Only what has already arrived is dropped, and a task turn is all it
        // takes to collect it: waiting 5 ms here cost a full second per
        // exchange in a hidden tab, where Chrome clamps timers to 1 s.
        // Bounded: a noisy line, or a second master polling the same bus,
        // delivers bytes continuously, and an unbounded drain would hold the
        // whole request pipeline hostage.
        const deadline = performance.now() + 100;
        for (;;) {
            const reader = this.acquireReader();
            if (!reader || !this.isOpen)
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

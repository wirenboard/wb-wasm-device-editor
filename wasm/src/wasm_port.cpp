#include <algorithm>
#include <emscripten/emscripten.h>
#include <emscripten/val.h>

#include <wblib/utils.h>

#include "log.h"
#include "serial_exc.h"
#include "wasm_port.h"

#define LOG(logger) logger.Log() << "[wasm port] "

namespace
{
    // WebSerial hands bytes over in USB-sized batches with a latency of its
    // own (an FTDI adapter's latency timer alone is 16 ms), so the
    // microsecond-scale gaps the protocol code computes from the baud rate
    // cannot be told apart from a batch boundary. Every wait is floored to
    // what the browser can actually resolve.
    const std::chrono::milliseconds MIN_RESPONSE_TIMEOUT(30);
    const std::chrono::milliseconds MIN_FRAME_TIMEOUT(25);

    int ToMilliseconds(const std::chrono::microseconds& us, const std::chrono::milliseconds& floor)
    {
        auto ms = std::chrono::ceil<std::chrono::milliseconds>(us);
        return static_cast<int>(std::max(ms, floor).count());
    }

    // One chunk from the serial port: whatever has arrived within timeoutMs,
    // at most count bytes. Zero means nothing arrived.
    int ReadChunk(uint8_t* buffer, size_t count, int timeoutMs)
    {
        // clang-format off
        return EM_ASM_INT(
        {
            let result = Asyncify.handleAsync(async() => { return await Module.serial.readChunk($1, $2); });

            if (!(result instanceof Uint8Array) || result.length == 0) {
                return 0;
            }

            Module.HEAPU8.set(result, $0);
            return result.length;
        },
        buffer, count, timeoutMs);
        // clang-format on
    }
}

TWASMPort::TWASMPort()
{}

void TWASMPort::Open()
{}

void TWASMPort::Close()
{}

bool TWASMPort::IsOpen() const
{
    return true;
}

void TWASMPort::CheckPortOpen() const
{}

void TWASMPort::WriteBytes(const uint8_t* buffer, int count)
{
    // clang-format off
    EM_ASM(
    {
        let data = Module.HEAPU8.slice($0, $0 + $1);
        Asyncify.handleAsync(async() => { await Module.serial.write(data); });
    },
    buffer, count);
    // clang-format on

    LOG(Debug) << "write " << count << " bytes: " << WBMQTT::HexDump(buffer, count);
}

uint8_t TWASMPort::ReadByte(const std::chrono::microseconds& timeout)
{
    uint8_t byte = 0;
    if (ReadChunk(&byte, 1, ToMilliseconds(timeout, MIN_RESPONSE_TIMEOUT)) == 0) {
        throw std::runtime_error("request timed out");
    }
    return byte;
}

TReadFrameResult TWASMPort::ReadFrame(uint8_t* buffer,
                                      size_t count,
                                      const std::chrono::microseconds& responseTimeout,
                                      const std::chrono::microseconds& frameTimeout,
                                      TFrameCompletePred frame_complete)
{
    // The same contract as TFileDescriptorPort::ReadFrame: wait up to
    // responseTimeout for the first byte, then treat a gap of frameTimeout as
    // the end of the frame — or stop as soon as the protocol says the frame
    // is complete, which is how a reply of known size returns without waiting
    // for any gap at all.
    TReadFrameResult res;
    if (!count) {
        return res;
    }

    auto start = std::chrono::steady_clock::now();
    int timeoutMs = ToMilliseconds(responseTimeout, MIN_RESPONSE_TIMEOUT);
    while (res.Count < count) {
        if (frame_complete && frame_complete(buffer, res.Count)) {
            break;
        }
        int n = ReadChunk(buffer + res.Count, count - res.Count, timeoutMs);
        if (n <= 0) {
            break;
        }
        if (res.Count == 0) {
            res.ResponseTime =
                std::chrono::duration_cast<std::chrono::microseconds>(std::chrono::steady_clock::now() - start);
        }
        res.Count += n;
        timeoutMs = ToMilliseconds(frameTimeout, MIN_FRAME_TIMEOUT);
    }

    if (!res.Count) {
        // Deliberately NOT the TPort-contract TResponseTimeoutException: that
        // type is transient, and wb-mqtt-serial's device paths (EnableEvents
        // during deviceLoad of a never-answering device) retry it in a way
        // that, under Asyncify, killed the renderer with a native stack
        // overflow — reproduced deterministically, and gone with a plain
        // runtime_error, which is also what this port always threw. port/Load
        // then reports the field-known "Port IO error: request timed out".
        throw std::runtime_error("request timed out");
    }

    LOG(Debug) << "read " << res.Count << " bytes: " << WBMQTT::HexDump(buffer, res.Count);
    return res;
}

void TWASMPort::SkipNoise()
{
    // Whatever is sitting in the receive path — a late reply to a request that
    // already timed out — would otherwise be taken for the answer to the next
    // one. Only what is there now is dropped; nothing is waited for.
    // clang-format off
    EM_ASM(
    {
        Asyncify.handleAsync(async() => { await Module.serial.discardPending(); });
    });
    // clang-format on
}

void TWASMPort::SleepSinceLastInteraction(const std::chrono::microseconds& us)
{}

std::chrono::microseconds TWASMPort::GetSendTimeBytes(double bytesNumber) const
{
    // Start bit, data bits, an optional parity bit and the stop bits: the
    // protocol code sizes its inter-frame gaps and arbitration windows in
    // these units, and they used to come out as zero here.
    double bitsPerByte = 1 + Settings.DataBits + (Settings.Parity == 'N' ? 0 : 1) + Settings.StopBits;
    return GetSendTimeBits(static_cast<size_t>(bitsPerByte * bytesNumber + 0.5));
}

std::chrono::microseconds TWASMPort::GetSendTimeBits(size_t bitsNumber) const
{
    if (Settings.BaudRate <= 0) {
        return std::chrono::microseconds(0);
    }
    return std::chrono::microseconds(static_cast<int64_t>(bitsNumber) * 1000000 / Settings.BaudRate);
}

std::string TWASMPort::GetDescription(bool verbose) const
{
    return "WASM port";
}

void TWASMPort::ApplySerialPortSettings(const TSerialPortConnectionSettings& settings)
{
    Settings = settings;
    // clang-format off
    EM_ASM(
    {
        Module.serial.setOptions($0, $1, $2, $3);
    },
    settings.BaudRate, settings.DataBits, settings.Parity, settings.StopBits);
    // clang-format on

    LOG(Debug) << "set options: " << settings.BaudRate << " " << settings.DataBits << "-" << settings.Parity << "-"
               << settings.StopBits;
}

void TWASMPort::ResetSerialPortSettings()
{
    // A request may set its own line settings for the duration (see
    // TSerialPortSettingsGuard); the browser's port keeps them until the next
    // request states its own, so there is nothing to restore here.
}

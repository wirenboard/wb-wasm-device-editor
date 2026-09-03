#include <algorithm>
#include <cmath>
#include <emscripten/emscripten.h>
#include <emscripten/val.h>

#include <wblib/utils.h>

#include "log.h"
#include "serial_exc.h"
#include "wasm_port.h"

#define LOG(logger) logger.Log() << "[wasm port] "

namespace
{
    // WebSerial hands bytes over in USB-sized batches with a latency of its own,
    // so the microsecond gaps computed from the baud rate are not observable
    const std::chrono::milliseconds MIN_RESPONSE_TIMEOUT(30);
    const std::chrono::milliseconds MIN_FRAME_TIMEOUT(25);

    int ToMilliseconds(const std::chrono::microseconds& us, const std::chrono::milliseconds& floor)
    {
        return static_cast<int>(std::max(std::chrono::ceil<std::chrono::milliseconds>(us), floor).count());
    }

    // Whatever has arrived within timeoutMs, at most count bytes, 0 if nothing
    int ReadChunk(uint8_t* buffer, size_t count, int timeoutMs)
    {
        // Emscripten runs the body twice, to unwind and to rewind, and only the
        // async callback runs once, on the real reply. Anything outside it works
        // on the value the previous suspension delivered
        // clang-format off
        return EM_ASM_INT(
        {
            return Asyncify.handleAsync(async() => {
                const result = await Module.serial.readChunk($1, $2);

                // A reply longer than the buffer is a broken contract, not
                // something to truncate: writing it would corrupt the heap
                if (!(result instanceof Uint8Array) || result.length === 0 || result.length > $1) {
                    return 0;
                }

                Module.HEAPU8.set(result, $0);
                return result.length;
            });
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

    if (!ReadChunk(&byte, 1, ToMilliseconds(timeout, MIN_RESPONSE_TIMEOUT))) {
        throw TSerialDeviceTransientErrorException("timeout");
    }

    return byte;
}

TReadFrameResult TWASMPort::ReadFrame(uint8_t* buffer,
                                      size_t count,
                                      const std::chrono::microseconds& responseTimeout,
                                      const std::chrono::microseconds& frameTimeout,
                                      TFrameCompletePred frame_complete)
{
    // The TFileDescriptorPort contract: responseTimeout until the first byte,
    // then frameTimeout as the inter-byte gap that ends the frame, or an early
    // return as soon as the protocol says the frame is complete
    TReadFrameResult res;

    if (!count) {
        return res;
    }

    auto start = std::chrono::steady_clock::now();
    auto timeoutMs = ToMilliseconds(responseTimeout, MIN_RESPONSE_TIMEOUT);

    while (res.Count < count) {
        if (frame_complete && frame_complete(buffer, res.Count)) {
            break;
        }

        auto length = ReadChunk(buffer + res.Count, count - res.Count, timeoutMs);

        if (length <= 0) {
            break;
        }

        if (!res.Count) {
            res.ResponseTime =
                std::chrono::duration_cast<std::chrono::microseconds>(std::chrono::steady_clock::now() - start);
        }

        res.Count += length;
        timeoutMs = ToMilliseconds(frameTimeout, MIN_FRAME_TIMEOUT);
    }

    if (!res.Count) {
        // Not TResponseTimeoutException: wb-mqtt-serial retries that one in a way
        // that recurses under Asyncify and kills the renderer
        throw std::runtime_error("request timed out");
    }

    LOG(Debug) << "read " << res.Count << " bytes: " << WBMQTT::HexDump(buffer, res.Count);
    return res;
}

void TWASMPort::SkipNoise()
{
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
    size_t bitsPerByte = 1 + Settings.DataBits + Settings.StopBits;

    if (Settings.Parity != 'N') {
        ++bitsPerByte;
    }

    return GetSendTimeBits(std::ceil(bitsPerByte * bytesNumber));
}

std::chrono::microseconds TWASMPort::GetSendTimeBits(size_t bitsNumber) const
{
    // Unlike TSerialPort's, these settings come from a request, so guard the divisor
    if (Settings.BaudRate <= 0) {
        return std::chrono::microseconds(0);
    }

    auto us = std::ceil(bitsNumber * 1000000.0 / double(Settings.BaudRate));
    return std::chrono::microseconds(static_cast<std::chrono::microseconds::rep>(us));
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

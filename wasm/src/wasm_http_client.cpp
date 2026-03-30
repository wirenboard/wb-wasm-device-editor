
#include <emscripten/emscripten.h>

#include "log.h"
#include "wasm_http_client.h"

#define LOG(logger) logger.Log() << "[wasm http] "

std::string TWASMHttpClient::GetText(const std::string& url)
{
    // clang-format off
    auto ptr = (char*)EM_ASM_INT(
    {
        let url = UTF8ToString($0);
        let result = Asyncify.handleAsync(async() => { return await Module.httpGetText(url); });
        return result;
    },
    url.c_str());
    // clang-format on

    if (!ptr) {
        throw std::runtime_error("HTTP request failed for " + url);
    }

    std::string result(ptr);
    free(ptr);

    LOG(Debug) << "http get text from " << url << ": " << result.size() << " bytes";
    return result;
}

std::vector<uint8_t> TWASMHttpClient::GetBinary(const std::string& url)
{
    // clang-format off
    auto packed = EM_ASM_INT(
    {
        let url = UTF8ToString($0);
        let result = Asyncify.handleAsync(async() => { return await Module.httpGetBinary(url); });
        return result;
    },
    url.c_str());
    // clang-format on

    if (!packed) {
        throw std::runtime_error("HTTP request failed for " + url);
    }

    auto ptr = reinterpret_cast<uint8_t*>(packed);
    uint32_t length;
    std::memcpy(&length, ptr, sizeof(length));

    auto data = ptr + sizeof(length);
    std::vector<uint8_t> result(data, data + length);
    free(ptr);

    LOG(Debug) << "http get binary from " << url << ": " << result.size() << " bytes";
    return result;
}

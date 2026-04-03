#pragma once

#include "rpc/rpc_fw_downloader.h"

class TWASMHttpClient: public IHttpClient
{
public:
    std::string GetText(const std::string& url) override;
    std::vector<uint8_t> GetBinary(const std::string& url) override;
};

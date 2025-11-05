#pragma once

#include "declarations.h"

#include <string>

namespace WBMQTT
{
    struct TDriverArgs
    {
        std::string Id;
        PDriverBackend DriverBackend = nullptr;
        bool IsTesting = false, UseStorage = false, ReownUnknownDevices = false;
        std::string StoragePath;

        TDriverArgs&& SetId(std::string id)
        {
            Id = std::move(id);
            return std::move(*this);
        }
        TDriverArgs&& SetBackend(const PDriverBackend& backend)
        {
            DriverBackend = backend;
            return std::move(*this);
        }
        TDriverArgs&& SetIsTesting(bool isTesting)
        {
            IsTesting = isTesting;
            return std::move(*this);
        }
        TDriverArgs&& SetUseStorage(bool useStorage)
        {
            UseStorage = useStorage;
            return std::move(*this);
        }
        TDriverArgs&& SetReownUnknownDevices(bool reownUnknownDevices)
        {
            ReownUnknownDevices = reownUnknownDevices;
            return std::move(*this);
        }
        TDriverArgs&& SetStoragePath(std::string storagePath)
        {
            StoragePath = std::move(storagePath);
            return std::move(*this);
        }
    };

    struct TPublishParameters
    {
        enum TPublishPolicy
        {
            PublishOnlyOnChange = 0, // Publish values only on change
            PublishAll,              // Publish for every call of TControl::SetValue and friends
            PublishSomeUnchanged     // Do not publish unchanged values during PublishUnchangedInterval
        };

        TPublishPolicy Policy = PublishAll;
        std::chrono::milliseconds PublishUnchangedInterval = std::chrono::milliseconds::zero();

        void Set(int32_t value);
    };
}

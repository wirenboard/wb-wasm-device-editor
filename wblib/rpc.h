#pragma once

#include "declarations.h"

#include "json/json.h"

namespace WBMQTT
{
    // RPC server error codes
    enum TMqttRpcErrorCode
    {
        E_RPC_PARSE_ERROR = -32700,
        E_RPC_SERVER_ERROR = -32000,
        E_RPC_REQUEST_TIMEOUT = -32600
    };

    class TMqttRpcServer
    {
    public:
        using TMethodHandler = std::function<Json::Value(const Json::Value&)>;
        using TResultCallback = std::function<void(const Json::Value&)>;
        using TErrorCallback = std::function<void(const TMqttRpcErrorCode, const std::string&)>;
        using TAsyncMethodHandler = std::function<void(const Json::Value&, TResultCallback, TErrorCallback)>;

        virtual void RegisterMethod(const std::string& service, const std::string& method, TMethodHandler handler) = 0;
        virtual void RegisterAsyncMethod(const std::string& service,
                                         const std::string& method,
                                         TAsyncMethodHandler handler) = 0;
        virtual void Start() = 0;
        virtual void Stop() = 0;
    };

    PMqttRpcServer NewMqttRpcServer(const PMqttClient client, const std::string driverId);
}

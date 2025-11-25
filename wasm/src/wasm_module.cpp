#include "log.h"
#include "port/feature_port.h"
#include "wasm_port.h"

#include "rpc/rpc_config_handler.h"
#include "rpc/rpc_device_load_config_task.h"
#include "rpc/rpc_device_set_task.h"
#include "rpc/rpc_helpers.h"
#include "rpc/rpc_port_scan_serial_client_task.h"

#include <emscripten/bind.h>

#define LOG(logger) logger.Log() << "[wasm] "

using namespace std::chrono_literals;
using namespace std::chrono;

namespace
{
    const auto GROUP_NAMES_FILE = "groups.json";

    const auto COMMON_SCHEMA_FILE = "wb-mqtt-serial-confed-common.schema.json";
    const auto PORTS_SCHEMA_FILE = "wb-mqtt-serial-ports.schema.json";
    const auto TEMPLATES_SCHEMA_FILE = "wb-mqtt-serial-device-template.schema.json";

    const auto PORT_SCAN_SCHEMA_FILE = "wb-mqtt-serial-rpc-port-scan-request.schema.json";
    const auto DEVICE_LOAD_CONFIG_SCHEMA_FILE = "wb-mqtt-serial-rpc-device-load-config-request.schema.json";
    const auto DEVICE_SET_SCHEMA_FILE = "wb-mqtt-serial-rpc-device-set-request.schema.json";

    const auto PROTOCOLS_DIR = "protocols";
    const auto TEMPLATES_DIR = "templates";

    PTemplateMap TemplateMap = nullptr;
    PRPCConfigHandler ConfigHandler = nullptr;
    auto Port = std::make_shared<TFeaturePort>(std::make_shared<TWASMPort>(), false);
    std::list<PSerialDevice> PolledDevices;

    class THelper
    {
        void ParseRequest(const std::string& requestString)
        {
            std::stringstream stream(requestString);
            Json::CharReaderBuilder builder;
            Json::String errors;

            if (!Json::parseFromStream(builder, stream, &Request, &errors)) {
                throw std::runtime_error("Failed to parse request:" + errors);
            }
        }

    public:
        Json::Value Request;
        TDeviceProtocolParams Params;
        PDeviceTemplate Template = nullptr;
        PSerialDevice Device = nullptr;

        THelper(const std::string& requestString,
                const std::string& schemaFilePath,
                const std::string& rpcName,
                bool deviceRequest = false)
        {
            auto schema = WBMQTT::JSON::Parse(COMMON_SCHEMA_FILE);

            TSerialDeviceFactory deviceFactory;
            RegisterProtocols(deviceFactory);

            if (!TemplateMap) {
                TemplateMap = std::make_shared<TTemplateMap>(LoadConfigTemplatesSchema(TEMPLATES_SCHEMA_FILE, schema));
                TemplateMap->AddTemplatesDir(TEMPLATES_DIR);
            }

            if (!ConfigHandler) {
                TDevicesConfedSchemasMap devicesSchemasMap(*TemplateMap, deviceFactory, schema);
                TProtocolConfedSchemasMap protocolSchemasMap(PROTOCOLS_DIR, schema);
                ConfigHandler = std::make_shared<TRPCConfigHandler>(WBMQTT::JSON::Parse(PORTS_SCHEMA_FILE),
                                                                    TemplateMap,
                                                                    devicesSchemasMap,
                                                                    protocolSchemasMap,
                                                                    WBMQTT::JSON::Parse(GROUP_NAMES_FILE));
            }

            ParseRequest(requestString);

            if (!schemaFilePath.empty()) {
                ValidateRPCRequest(Request, LoadRPCRequestSchema(schemaFilePath, rpcName));
            }

            if (!deviceRequest) {
                return;
            }

            Params = deviceFactory.GetProtocolParams("modbus");

            auto config = std::make_shared<TDeviceConfig>("WASM Device", Request["slave_id"].asString(), "modbus");
            config->MaxRegHole = Modbus::MAX_HOLE_CONTINUOUS_16_BIT_REGISTERS;
            config->MaxBitHole = Modbus::MAX_HOLE_CONTINUOUS_1_BIT_REGISTERS;
            config->MaxReadRegisters = Modbus::MAX_READ_REGISTERS;

            try {
                Template = TemplateMap->GetTemplate(Request["device_type"].asString());
                Device = Params.factory->CreateDevice(Template->GetTemplate(), config, Params.protocol);
            } catch (const std::out_of_range& e) {
                LOG(Error) << "Unable to create device: " << e.what();
            }
        }

        TSerialClientDeviceAccessHandler GetAccessHandler()
        {
            std::list<PSerialDevice> list;

            if (Device) {
                list.push_back(Device);
            }

            TSerialClientRegisterAndEventsReader client(list, 50ms, []() { return steady_clock::now(); });
            return TSerialClientDeviceAccessHandler(client.GetEventsReader());
        }
    };

    void SendReply(const Json::Value& reply)
    {
        std::stringstream stream;
        WBMQTT::JSON::MakeWriter()->write(reply, &stream);

        // clang-format off
        EM_ASM(
        {
            let data = new String();

            for (let i = 0; i < $1; ++i) {
                data += String.fromCharCode(getValue($0 + i, 'i8'));
            }

            Module.parseReply(data);
        },
        stream.str().c_str(), stream.str().length());
        // clang-format on
    }

    void OnResult(const Json::Value& result)
    {
        Json::Value reply;
        reply["error"] = Json::nullValue;
        reply["result"] = result;

        SendReply(reply);
    }

    void OnError(const WBMQTT::TMqttRpcErrorCode& errorCode, const std::string& errorMessage)
    {
        Json::Value error;
        error["code"] = static_cast<int>(errorCode);
        error["message"] = errorMessage;

        Json::Value reply;
        reply["error"] = error;

        SendReply(reply);
    }
}

void ConfigGetDeviceTypes(const std::string& requestString)
{
    try {
        THelper helper(requestString, std::string(), "config/GetDeviceTypes");
        OnResult(ConfigHandler->GetDeviceTypes(helper.Request));
    } catch (const std::runtime_error& e) {
        LOG(Error) << "config/GetDeviceTypes RPC failed: " << e.what();
    }
}

void ConfigGetSchema(const std::string& requestString)
{
    try {
        THelper helper(requestString, std::string(), "config/GetSchema");
        OnResult(ConfigHandler->GetSchema(helper.Request));
    } catch (const std::runtime_error& e) {
        LOG(Error) << "config/GetSchema RPC failed: " << e.what();
    }
}

void PortScan(const std::string& requestString)
{
    try {
        THelper helper(requestString, PORT_SCAN_SCHEMA_FILE, "port/Scan");
        auto accessHandler = helper.GetAccessHandler();
        TRPCPortScanSerialClientTask(helper.Request, OnResult, OnError).Run(Port, accessHandler, PolledDevices);
    } catch (const std::runtime_error& e) {
        LOG(Error) << "port/Scan RPC failed: " << e.what();
    }
}

void DeviceLoadConfig(const std::string& requestString)
{
    try {
        THelper helper(requestString, DEVICE_LOAD_CONFIG_SCHEMA_FILE, "device/LoadConfig", true);
        TRPCDeviceParametersCache parametersCache;
        auto rpcRequest = ParseRPCDeviceLoadConfigRequest(helper.Request,
                                                          helper.Params,
                                                          helper.Device,
                                                          helper.Template,
                                                          false,
                                                          parametersCache,
                                                          OnResult,
                                                          OnError);
        auto accessHandler = helper.GetAccessHandler();
        TRPCDeviceLoadConfigSerialClientTask(rpcRequest).Run(Port, accessHandler, PolledDevices);
    } catch (const std::runtime_error& e) {
        LOG(Error) << "device/LoadConfig RPC failed: " << e.what();
    }
}

void DeviceSet(const std::string& requestString)
{
    try {
        THelper helper(requestString, DEVICE_SET_SCHEMA_FILE, "device/Set", true);
        auto rpcRequest = ParseRPCDeviceSetRequest(helper.Request,
                                                   helper.Params,
                                                   helper.Device,
                                                   helper.Template,
                                                   false,
                                                   OnResult,
                                                   OnError);
        auto accessHandler = helper.GetAccessHandler();
        TRPCDeviceSetSerialClientTask(rpcRequest).Run(Port, accessHandler, PolledDevices);
    } catch (const std::runtime_error& e) {
        LOG(Error) << "device/Set RPC failed: " << e.what();
    }
}

EMSCRIPTEN_BINDINGS(module)
{
    emscripten::function("configGetDeviceTypes", &ConfigGetDeviceTypes);
    emscripten::function("configGetSchema", &ConfigGetSchema);
    emscripten::function("portScan", &PortScan);
    emscripten::function("deviceLoadConfig", &DeviceLoadConfig);
    emscripten::function("deviceSet", &DeviceSet);
}

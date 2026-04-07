#include <emscripten/bind.h>

#include "config_merge_template.h"
#include "log.h"
#include "port/feature_port.h"

#include "wasm_http_client.h"
#include "wasm_port.h"

#include "rpc/rpc_config_handler.h"
#include "rpc/rpc_device_load_config_task.h"
#include "rpc/rpc_device_load_task.h"
#include "rpc/rpc_device_set_task.h"
#include "rpc/rpc_fw_get_firmware_info_task.h"
#include "rpc/rpc_fw_restore_task.h"
#include "rpc/rpc_fw_update_serial_client_task.h"
#include "rpc/rpc_helpers.h"
#include "rpc/rpc_port_load_modbus_serial_client_task.h"
#include "rpc/rpc_port_scan_serial_client_task.h"
#include "rpc/rpc_port_setup_serial_client_task.h"

#define LOG(logger) logger.Log() << "[wasm] "

using namespace std::chrono_literals;
using namespace std::chrono;

namespace
{
    const auto GROUP_NAMES_FILE = "groups.json";
    const auto RELEASE_SUITE = "stable";

    const auto COMMON_SCHEMA_FILE = "wb-mqtt-serial-confed-common.schema.json";
    const auto PORTS_SCHEMA_FILE = "wb-mqtt-serial-ports.schema.json";
    const auto TEMPLATES_SCHEMA_FILE = "wb-mqtt-serial-device-template.schema.json";

    const auto PORT_LOAD_SCHEMA_FILE = "wb-mqtt-serial-rpc-port-load-request.schema.json";
    const auto PORT_SCAN_SCHEMA_FILE = "wb-mqtt-serial-rpc-port-scan-request.schema.json";
    const auto PORT_SETUP_SCHEMA_FILE = "wb-mqtt-serial-rpc-port-setup-request.schema.json";

    const auto DEVICE_LOAD_CONFIG_SCHEMA_FILE = "wb-mqtt-serial-rpc-device-load-config-request.schema.json";
    const auto DEVICE_LOAD_SCHEMA_FILE = "wb-mqtt-serial-rpc-device-load-request.schema.json";
    const auto DEVICE_SET_SCHEMA_FILE = "wb-mqtt-serial-rpc-device-set-request.schema.json";

    const auto PROTOCOLS_DIR = "protocols";
    const auto TEMPLATES_DIR = "templates";

    const auto CommonSchema = WBMQTT::JSON::Parse(COMMON_SCHEMA_FILE);

    auto Prepare = true;
    auto Port = std::make_shared<TFeaturePort>(std::make_shared<TWASMPort>(), false);
    TSerialDeviceFactory DeviceFactory;
    std::list<PSerialDevice> PolledDevices;

    PTemplateMap TemplateMap;
    PRPCConfigHandler ConfigHandler;

    std::shared_ptr<TDevicesConfedSchemasMap> DevicesSchemasMap;
    std::shared_ptr<TProtocolConfedSchemasMap> ProtocolSchemasMap;

    std::shared_ptr<TFwUpdateLock> FwUpdateLock = std::make_shared<TFwUpdateLock>();
    std::shared_ptr<TFwUpdateState> FwState;
    std::shared_ptr<TFwDownloader> FwDownloader;

    void SendString(const std::string& string, bool fwUpdateState = false)
    {
        // clang-format off
        EM_ASM(
        {
            let data = new TextDecoder().decode(Module.HEAPU8.subarray($0, $0 + $1));
            Module.parseString(data, $2);
        },
        string.c_str(), string.length(), fwUpdateState);
        // clang-format on
    }

    void SendReply(const Json::Value& reply)
    {
        std::stringstream stream;
        WBMQTT::JSON::MakeWriter()->write(reply, &stream);
        SendString(stream.str());
    }

    void SendFwUpdateState(const std::string&, const std::string& payload, bool)
    {
        SendString(payload, true);
    }

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
            if (Prepare) {
                RegisterProtocols(DeviceFactory);
                TemplateMap =
                    std::make_shared<TTemplateMap>(LoadConfigTemplatesSchema(TEMPLATES_SCHEMA_FILE, CommonSchema));
                DevicesSchemasMap =
                    std::make_shared<TDevicesConfedSchemasMap>(*TemplateMap, DeviceFactory, CommonSchema);
                ProtocolSchemasMap = //
                    std::make_shared<TProtocolConfedSchemasMap>(PROTOCOLS_DIR, CommonSchema);
                ConfigHandler = //
                    std::make_shared<TRPCConfigHandler>(WBMQTT::JSON::Parse(PORTS_SCHEMA_FILE),
                                                        TemplateMap,
                                                        *DevicesSchemasMap,
                                                        *ProtocolSchemasMap,
                                                        WBMQTT::JSON::Parse(GROUP_NAMES_FILE));
                TemplateMap->AddTemplatesDir(TEMPLATES_DIR);

                auto httpClient = std::make_shared<TWASMHttpClient>();
                FwDownloader = std::make_shared<TFwDownloader>(httpClient);
                FwState = std::make_shared<TFwUpdateState>(SendFwUpdateState, std::string());
                // FwState->Reset();

                Prepare = false;
            }

            ParseRequest(requestString);

            if (!schemaFilePath.empty()) {
                ValidateRPCRequest(Request, LoadRPCRequestSchema(schemaFilePath, rpcName));
            }

            if (!deviceRequest) {
                return;
            }

            Params = DeviceFactory.GetProtocolParams("modbus");

            auto config = std::make_shared<TDeviceConfig>("WASM Device", Request["slave_id"].asString(), "modbus");
            config->MaxRegHole = Modbus::MAX_HOLE_CONTINUOUS_16_BIT_REGISTERS;
            config->MaxBitHole = Modbus::MAX_HOLE_CONTINUOUS_1_BIT_REGISTERS;
            config->MaxReadRegisters = Modbus::MAX_READ_REGISTERS;

            try {
                Template = TemplateMap->GetTemplate(Request["device_type"].asString());
                Device = Params.factory->CreateDevice(Template->GetTemplate(), config, Params.protocol);
                Device->SetWbDevice(!Template->GetHardware().empty() ||
                                    Template->GetTemplate()["enable_wb_continuous_read"].asBool());
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

    void DummyResult(const Json::Value&)
    {}

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
    } catch (const std::exception& e) {
        LOG(Error) << "config/GetDeviceTypes RPC failed: " << e.what();
        OnError(WBMQTT::E_RPC_SERVER_ERROR, e.what());
    }
}

void ConfigGetSchema(const std::string& requestString)
{
    try {
        THelper helper(requestString, std::string(), "config/GetSchema");
        OnResult(ConfigHandler->GetSchema(helper.Request));
    } catch (const std::exception& e) {
        LOG(Error) << "config/GetSchema RPC failed: " << e.what();
        OnError(WBMQTT::E_RPC_SERVER_ERROR, e.what());
    }
}

void PortLoad(const std::string& requestString)
{
    try {
        THelper helper(requestString, PORT_LOAD_SCHEMA_FILE, "port/Load");
        TRPCDeviceParametersCache parametersCache;
        TRPCPortLoadModbusSerialClientTask task(helper.Request, OnResult, OnError, parametersCache);
        auto accessHandler = helper.GetAccessHandler();
        task.Run(Port, accessHandler, PolledDevices);
    } catch (const std::exception& e) {
        LOG(Error) << "port/Load RPC failed: " << e.what();
        OnError(WBMQTT::E_RPC_SERVER_ERROR, e.what());
    }
}

void PortScan(const std::string& requestString)
{
    try {
        THelper helper(requestString, PORT_SCAN_SCHEMA_FILE, "port/Scan");
        TRPCPortScanSerialClientTask task(helper.Request, OnResult, OnError);
        auto accessHandler = helper.GetAccessHandler();
        task.Run(Port, accessHandler, PolledDevices);
    } catch (const std::exception& e) {
        LOG(Error) << "port/Scan RPC failed: " << e.what();
        OnError(WBMQTT::E_RPC_SERVER_ERROR, e.what());
    }
}

void PortSetup(const std::string& requestString)
{
    try {
        THelper helper(requestString, PORT_SETUP_SCHEMA_FILE, "port/Setup");
        TRPCPortSetupSerialClientTask task(helper.Request, OnResult, OnError);
        auto accessHandler = helper.GetAccessHandler();
        task.Run(Port, accessHandler, PolledDevices);
    } catch (const std::exception& e) {
        LOG(Error) << "port/Setup RPC failed: " << e.what();
        OnError(WBMQTT::E_RPC_SERVER_ERROR, e.what());
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
                                                          std::string(),
                                                          parametersCache,
                                                          OnResult,
                                                          OnError);
        auto accessHandler = helper.GetAccessHandler();
        TRPCDeviceLoadConfigSerialClientTask(rpcRequest).Run(Port, accessHandler, PolledDevices);
    } catch (const std::exception& e) {
        LOG(Error) << "device/LoadConfig RPC failed: " << e.what();
        OnError(WBMQTT::E_RPC_SERVER_ERROR, e.what());
    }
}

void DeviceLoad(const std::string& requestString)
{
    try {
        THelper helper(requestString, DEVICE_LOAD_SCHEMA_FILE, "device/Load", true);
        auto rpcRequest = ParseRPCDeviceLoadRequest(helper.Request,
                                                    helper.Params,
                                                    helper.Device,
                                                    helper.Template,
                                                    false,
                                                    OnResult,
                                                    OnError);
        auto accessHandler = helper.GetAccessHandler();
        TRPCDeviceLoadSerialClientTask(rpcRequest).Run(Port, accessHandler, PolledDevices);
    } catch (const std::exception& e) {
        LOG(Error) << "device/Load RPC failed: " << e.what();
        OnError(WBMQTT::E_RPC_SERVER_ERROR, e.what());
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
    } catch (const std::exception& e) {
        LOG(Error) << "device/Set RPC failed: " << e.what();
        OnError(WBMQTT::E_RPC_SERVER_ERROR, e.what());
    }
}

void FwGetInfo(const std::string& requestString)
{
    try {
        THelper helper(requestString, std::string(), "fw-update/GetFirmwareInfo");
        TFwGetFirmwareInfoTask task(static_cast<uint8_t>(helper.Request["slave_id"].asInt()),
                                    "modbus",
                                    RELEASE_SUITE,
                                    ParseRPCSerialPortSettings(helper.Request),
                                    FwDownloader,
                                    OnResult,
                                    OnError);
        auto accessHandler = helper.GetAccessHandler();
        task.Run(Port, accessHandler, PolledDevices);
    } catch (const std::exception& e) {
        LOG(Error) << "fw-update/GetFirmwareInfo RPC failed: " << e.what();
        OnError(WBMQTT::E_RPC_SERVER_ERROR, e.what());
    }
}

void FwUpdate(const std::string& requestString)
{
    try {
        THelper helper(requestString, std::string(), "fw-update/Update");
        TFwUpdateSerialClientTask task(static_cast<uint8_t>(helper.Request["slave_id"].asInt()),
                                       "modbus",
                                       helper.Request.get("type", "firmware").asString(),
                                       "wasm",
                                       RELEASE_SUITE,
                                       ParseRPCSerialPortSettings(helper.Request),
                                       FwDownloader,
                                       FwState,
                                       FwUpdateLock,
                                       DummyResult,
                                       OnError);
        auto accessHandler = helper.GetAccessHandler();
        task.Run(Port, accessHandler, PolledDevices);
        OnResult(Json::Value("Ok"));
    } catch (const std::exception& e) {
        LOG(Error) << "fw-update/Update RPC failed: " << e.what();
        OnError(WBMQTT::E_RPC_SERVER_ERROR, e.what());
    }
}

void FwRestore(const std::string& requestString)
{
    try {
        THelper helper(requestString, std::string(), "fw-update/Restore");
        TFwRestoreTask task(static_cast<uint8_t>(helper.Request["slave_id"].asInt()),
                            "modbus",
                            "wasm",
                            RELEASE_SUITE,
                            ParseRPCSerialPortSettings(helper.Request),
                            FwDownloader,
                            FwState,
                            FwUpdateLock,
                            DummyResult,
                            OnError);
        auto accessHandler = helper.GetAccessHandler();
        task.Run(Port, accessHandler, PolledDevices);
        OnResult(Json::Value("Ok"));
    } catch (const std::exception& e) {
        LOG(Error) << "fw-update/Restore RPC failed: " << e.what();
        OnError(WBMQTT::E_RPC_SERVER_ERROR, e.what());
    }
}

void FwClearError(const std::string& requestString)
{
    try {
        THelper helper(requestString, std::string(), "fw-update/ClearError");
        FwState->ClearError(static_cast<uint8_t>(helper.Request["slave_id"].asInt()),
                            "wasm",
                            helper.Request.get("type", "firmware").asString());
        OnResult(Json::Value("Ok"));
    } catch (const std::exception& e) {
        LOG(Error) << "fw-update/ClearError RPC failed: " << e.what();
        OnError(WBMQTT::E_RPC_SERVER_ERROR, e.what());
    }
}

EMSCRIPTEN_BINDINGS(module)
{
    emscripten::function("configGetDeviceTypes", &ConfigGetDeviceTypes);
    emscripten::function("configGetSchema", &ConfigGetSchema);
    emscripten::function("portLoad", &PortLoad);
    emscripten::function("portScan", &PortScan);
    emscripten::function("portSetup", &PortSetup);
    emscripten::function("deviceLoadConfig", &DeviceLoadConfig);
    emscripten::function("deviceLoad", &DeviceLoad);
    emscripten::function("deviceSet", &DeviceSet);
    emscripten::function("fwGetInfo", &FwGetInfo);
    emscripten::function("fwUpdate", &FwUpdate);
    emscripten::function("fwRestore", &FwRestore);
    emscripten::function("fwClearError", &FwClearError);
}

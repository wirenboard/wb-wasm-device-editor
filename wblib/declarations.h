#pragma once

#include "any.h"
#include "map.h"

#include <functional>
#include <map>
#include <memory>

namespace WBMQTT
{
    class TDriver;
    class TDeviceDriver;
    class TControl;
    class TDevice;
    class TLocalDevice;
    class TExternalDevice;
    class TDriverTx;
    class TDeviceDriverTx;
    class TDeviceFilter;
    class TDriverBackend;
    class TDriverFrontend;
    class TKeyValueStorage;
    class TBaseException;

    // Args
    struct TLocalDeviceArgs;
    class TControlArgs;
    struct TDriverArgs;

    // Driver backend requests
    struct TDriverRequest;
    struct TRemoveDeviceRequest;
    struct TRemoveControlRequest;
    struct TRemoveUnusedControlsRequest;
    struct TRemoveUnusedDeviceSubTopicRequest;
    struct TRemoveExternalDeviceRequest;
    struct TRemoveExternalControlRequest;
    struct TNewDeviceRequest;
    struct TReplaceDeviceRequest;
    struct TNewDeviceControlRequest;
    struct TSetFilterRequest;
    struct TSetControlValueRequest;
    struct TUpdateDeviceMetaRequest;
    struct TUpdateControlMetaRequest;

    // Events
    struct TStartEvent;
    struct TStopEvent;
    struct TReadyEvent;
    struct TDriverEvent;
    struct TControlValueEvent;
    struct TControlOnValueEvent;
    struct TNewExternalDeviceControlMetaEvent;
    struct TDriverEventHandlerHandle;

    // Mqtt
    class TMqttClient;
    struct TMqttMessage;
    class TMqttRpcServer;

    using PDriver = std::shared_ptr<TDriver>;
    using PDeviceDriver = std::shared_ptr<TDeviceDriver>;
    using PControl = std::shared_ptr<TControl>;
    using PDevice = std::shared_ptr<TDevice>;
    using PLocalDevice = std::shared_ptr<TLocalDevice>;
    using PExternalDevice = std::shared_ptr<TExternalDevice>;
    using PDriverTx = std::unique_ptr<TDriverTx>;
    using PDeviceFilter = std::shared_ptr<TDeviceFilter>;
    using PDriverBackend = std::shared_ptr<TDriverBackend>;
    using PDriverFrontend = std::shared_ptr<TDriverFrontend>;
    using PKeyValueStorage = std::shared_ptr<TKeyValueStorage>;
    using PBaseException = std::shared_ptr<TBaseException>;

    // Driver backend requests
    using PDriverRequest = std::shared_ptr<TDriverRequest>;
    using PRemoveDeviceRequest = std::shared_ptr<TRemoveDeviceRequest>;
    using PRemoveControlRequest = std::shared_ptr<TRemoveControlRequest>;
    using PRemoveUnusedControlsRequest = std::shared_ptr<TRemoveUnusedControlsRequest>;
    using PRemoveUnusedDeviceSubTopicRequest = std::shared_ptr<TRemoveUnusedDeviceSubTopicRequest>;
    using PRemoveExternalDeviceRequest = std::shared_ptr<TRemoveExternalDeviceRequest>;
    using PRemoveExternalControlRequest = std::shared_ptr<TRemoveExternalControlRequest>;
    using PNewDeviceRequest = std::shared_ptr<TNewDeviceRequest>;
    using PReplaceDeviceRequest = std::shared_ptr<TReplaceDeviceRequest>;
    using PNewDeviceControlRequest = std::shared_ptr<TNewDeviceControlRequest>;
    using PSetFilterRequest = std::shared_ptr<TSetFilterRequest>;
    using PSetControlValueRequest = std::shared_ptr<TSetControlValueRequest>;
    using PUpdateDeviceMetaRequest = std::shared_ptr<TUpdateDeviceMetaRequest>;
    using PUpdateControlMetaRequest = std::shared_ptr<TUpdateControlMetaRequest>;

    // Events
    using PStartEvent = std::shared_ptr<TStartEvent>;
    using PStopEvent = std::shared_ptr<TStopEvent>;
    using PReadyEvent = std::shared_ptr<TReadyEvent>;
    using PDriverEvent = std::shared_ptr<TDriverEvent>;
    using PControlValueEvent = std::shared_ptr<TControlValueEvent>;
    using PControlOnValueEvent = std::shared_ptr<TControlOnValueEvent>;
    using PDriverEventHandlerHandle = std::shared_ptr<TDriverEventHandlerHandle>;

    // Mqtt
    using PMqttClient = std::shared_ptr<TMqttClient>;
    using PMqttRpcServer = std::shared_ptr<TMqttRpcServer>;

    // Functors
    using TThunkFunction = std::function<void(const PDriverTx&)>;
    using TDriverEventHandler = std::function<void(const TDriverEvent&)>;
    using TLocalDeviceFactory = std::function<PLocalDevice(TLocalDeviceArgs&&)>;
    using TExternalDeviceFactory = std::function<PExternalDevice(const std::string& id, PDeviceDriver)>;
    using TControlFactory = std::function<PControl(TControlArgs&&)>;
    using TMqttMessageHandler = std::function<void(const TMqttMessage&)>;
    using TControlValueHandler = std::function<void(PControl, const TAny&, const PDriverTx& tx)>;

    using PMqttMessageHandler = std::shared_ptr<TMqttMessageHandler>;

    // MetaInfo is a type that represents /meta/+ topics for drivers and controls
    using TMetaInfo = std::map<std::string, std::string>;

    // Common constants
    extern char const* const MQTT_PATH_DELIMITER;
}

#pragma once

#include <exception>
#include <string>

namespace WBMQTT
{
    class TBaseException: public std::exception
    {
    public:
        TBaseException(const char* file, int line, const std::string& message);
        virtual ~TBaseException() noexcept
        {}
        const char* what() const noexcept override
        {
            return Message.c_str();
        }

    protected:
        std::string Message;
    };

    /// Operation in not supported by this object
    class TUnsupportedOperationException: public TBaseException
    {
    public:
        TUnsupportedOperationException(const char* file, int line, const std::string& message)
            : TBaseException(file, line, message)
        {}
    };

    /// Wrong state. E.g. writing to an readonly object.
    class TInappropriateStateException: public TBaseException
    {
    public:
        TInappropriateStateException(const char* file, int line, const std::string& message)
            : TBaseException(file, line, message)
        {}
    };

    class TPromiseException: public TBaseException
    {
    public:
        TPromiseException(const char* file, int line, const std::string& message): TBaseException(file, line, message)
        {}
    };

    class TBrokenPromiseException: public TPromiseException
    {
    public:
        TBrokenPromiseException(const char* file, int line, const std::string& message)
            : TPromiseException(file, line, message)
        {}
    };

    class TPromiseRepeatedAssignmentException: public TPromiseException
    {
    public:
        TPromiseRepeatedAssignmentException(const char* file, int line, const std::string& message)
            : TPromiseException(file, line, message)
        {}
    };

    class TPromiseFutureException: public TPromiseException
    {
    public:
        TPromiseFutureException(const char* file, int line, const std::string& message)
            : TPromiseException(file, line, message)
        {}
    };

    /*!
     *  Exceptions that are throwed by TAny class
     */
    class TAnyException: public TBaseException
    {
    public:
        TAnyException(const char* file, int line, const std::string& message): TBaseException(file, line, message)
        {}
    };

    class TAnyCastError: public TAnyException
    {
    public:
        TAnyCastError(const char* file, int line, const std::string& message): TAnyException(file, line, message)
        {}
    };

    class TAnyEmptyError: public TAnyCastError
    {
    public:
        TAnyEmptyError(const char* file, int line);
    };

    class TAnyTypesMismatchError: public TAnyCastError
    {
    public:
        TAnyTypesMismatchError(const char* file,
                               int line,
                               const std::string& storedType,
                               const std::string& castingType);
    };

    /*!
     *  MQTT error
     */
    class TMqttException: public TBaseException
    {
    public:
        TMqttException(const char* file, int line, const std::string& message): TBaseException(file, line, message)
        {}
    };

    /*!
     *  MQTT RPC error
     */
    class TRequestTimeoutException: public TBaseException
    {
    public:
        TRequestTimeoutException(const char* file, int line, const std::string& message)
            : TBaseException(file, line, message)
        {}
    };

    /*!
     *  Storage error
     */
    class TStorageException: public TBaseException
    {
    public:
        TStorageException(const char* file, int line, const std::string& message): TBaseException(file, line, message)
        {}
    };

    class TStorageUnavailableError: public TStorageException
    {
    public:
        TStorageUnavailableError(const char* file, int line);
    };

    class TStorageValueNotFoundError: public TStorageException
    {
    public:
        TStorageValueNotFoundError(const char* file, int line, const std::string& key);
    };

    class TDeadlockError: public TBaseException
    {
    public:
        TDeadlockError(const char* file, int line, const char* subclassName);
    };

    /*!
     *  Frontend errors
     */
    class TFrontendException: public TBaseException
    {
    public:
        TFrontendException(const char* file, int line, const std::string& message): TBaseException(file, line, message)
        {}
    };

    class TValueException: public TFrontendException
    {
    public:
        TValueException(const char* file, int line, const std::string& message): TFrontendException(file, line, message)
        {}
    };

#define DECLARE_FRONTEND_DEVICE_EXCEPTION(name)                                                                        \
    class name: public TFrontendException                                                                              \
    {                                                                                                                  \
    public:                                                                                                            \
        name(const char* file, int line, const std::string& deviceId);                                                 \
    };

#define DECLARE_FRONTEND_CONTROL_EXCEPTION(name)                                                                       \
    class name: public TFrontendException                                                                              \
    {                                                                                                                  \
    public:                                                                                                            \
        name(const char* file, int line, const std::string& deviceId, const std::string& controlId);                   \
    };

#define DECLARE_FRONTEND_VALUE_EXCEPTION(name)                                                                         \
    class name: public TValueException                                                                                 \
    {                                                                                                                  \
    public:                                                                                                            \
        name(const char* file, int line, const std::string& arg);                                                      \
    };

#define DECLARE_FRONTEND_EXCEPTION(name)                                                                               \
    class name: public TFrontendException                                                                              \
    {                                                                                                                  \
    public:                                                                                                            \
        name(const char* file, int line);                                                                              \
    };

    /*!
     *  Backend errors
     */
    class TBackendException: public TBaseException
    {
    public:
        TBackendException(const char* file, int line, const std::string& message): TBaseException(file, line, message)
        {}
    };

#define DECLARE_BACKEND_DEVICE_EXCEPTION(name)                                                                         \
    class name: public TBackendException                                                                               \
    {                                                                                                                  \
    public:                                                                                                            \
        name(const char* file, int line, const std::string& deviceId);                                                 \
    };

#define DECLARE_BACKEND_CONTROL_EXCEPTION(name)                                                                        \
    class name: public TBackendException                                                                               \
    {                                                                                                                  \
    public:                                                                                                            \
        name(const char* file, int line, const std::string& deviceId, const std::string& controlId);                   \
    };

#define DECLARE_BACKEND_EXCEPTION(name)                                                                                \
    class name: public TBackendException                                                                               \
    {                                                                                                                  \
    public:                                                                                                            \
        name(const char* file, int line);                                                                              \
    };

// Exceptions declared using DECLARE_XXX_EXCEPTION can occur both on backend and frontend
#define DECLARE_CONTROL_EXCEPTION(name)                                                                                \
    class name: public TBaseException                                                                                  \
    {                                                                                                                  \
    public:                                                                                                            \
        name(const char* file, int line, const std::string& deviceId, const std::string& controlId);                   \
    };

#define DECLARE_DEVICE_EXCEPTION(name)                                                                                 \
    class name: public TBaseException                                                                                  \
    {                                                                                                                  \
    public:                                                                                                            \
        name(const char* file, int line, const std::string& deviceId);                                                 \
    };

    // common errors
    DECLARE_CONTROL_EXCEPTION(TNoSuchControlError)
    DECLARE_CONTROL_EXCEPTION(TControlAlreadyExistsError)

    DECLARE_DEVICE_EXCEPTION(TExternalDeviceRedefinitionError)
    DECLARE_DEVICE_EXCEPTION(TDeviceAlreadyExistsError)
    DECLARE_DEVICE_EXCEPTION(TNoSuchDeviceError)
    // common errors end

    // frontend errors
    DECLARE_FRONTEND_DEVICE_EXCEPTION(TDeviceDeletedError)
    DECLARE_FRONTEND_DEVICE_EXCEPTION(TUnknownDeviceMetaError)

    DECLARE_FRONTEND_CONTROL_EXCEPTION(TIncorrectControlIdError)
    DECLARE_FRONTEND_CONTROL_EXCEPTION(TControlDeletedError)
    DECLARE_FRONTEND_CONTROL_EXCEPTION(TLocalControlError)
    DECLARE_FRONTEND_CONTROL_EXCEPTION(TExternalControlError)
    DECLARE_FRONTEND_CONTROL_EXCEPTION(TIncompleteControlError)
    DECLARE_FRONTEND_CONTROL_EXCEPTION(TNotWritableControlError)
    DECLARE_FRONTEND_CONTROL_EXCEPTION(TUnknownControlMetaError)

    class TUnknownDataTypeError: public TValueException
    {
    public:
        TUnknownDataTypeError(const char* file, int line, const std::string& type);
    };

    class TInvalidValueError: public TValueException
    {
    public:
        TInvalidValueError(const char* file, int line, const std::string& value, const std::string& type);
    };

    DECLARE_FRONTEND_EXCEPTION(TControlArgumentsError)
    DECLARE_FRONTEND_EXCEPTION(TEventQueueFullError)
    DECLARE_FRONTEND_EXCEPTION(TDriverActiveError)
    DECLARE_FRONTEND_EXCEPTION(TDriverInactiveError)
    DECLARE_FRONTEND_EXCEPTION(TDriverWrongArgumentsError)
    DECLARE_FRONTEND_EXCEPTION(TDriverTimeoutError)
    DECLARE_FRONTEND_EXCEPTION(TDeviceRedefinitionError)
    DECLARE_FRONTEND_EXCEPTION(TControlRedefinitionError)
    DECLARE_FRONTEND_EXCEPTION(TNonLocalControlError)
    DECLARE_FRONTEND_EXCEPTION(TControlArgsMissingError)
    DECLARE_FRONTEND_EXCEPTION(TDeviceIdMissingError)
    DECLARE_FRONTEND_EXCEPTION(TLocalDeviceArgumentsError)
    DECLARE_FRONTEND_EXCEPTION(TAlreadyHasTransactionError)

    DECLARE_FRONTEND_DEVICE_EXCEPTION(TIncorrectDeviceIdError)
    // frontend errors end

    // backend errors
    DECLARE_BACKEND_DEVICE_EXCEPTION(TIsLocalDeviceError)
    DECLARE_BACKEND_DEVICE_EXCEPTION(TIsExternalDeviceError)

    DECLARE_BACKEND_EXCEPTION(TBackendActiveError)
    DECLARE_BACKEND_EXCEPTION(TBackendExternalDeviceFactoryNotSetError)
    DECLARE_BACKEND_EXCEPTION(TBackendControlFactoryNotSetError)
    // backend errors end

#undef DECLARE_CONTROL_EXCEPTION
#undef DECLARE_DEVICE_EXCEPTION

#undef DECLARE_FRONTEND_EXCEPTION
#undef DECLARE_FRONTEND_CONTROL_EXCEPTION
#undef DECLARE_FRONTEND_DEVICE_EXCEPTION

#undef DECLARE_BACKEND_EXCEPTION
#undef DECLARE_BACKEND_CONTROL_EXCEPTION
#undef DECLARE_BACKEND_DEVICE_EXCEPTION
}

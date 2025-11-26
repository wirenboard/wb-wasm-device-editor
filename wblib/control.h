#pragma once

#include "any.h"
#include "declarations.h"
#include "promise.h"

#include <functional>

namespace WBMQTT
{
    const int OrderAuto = -1;

    /*!
     *  Control is a user representation of Mqtt device control
     */
    class TControl: public std::enable_shared_from_this<TControl>
    {
        void ApplyArgs(const TControlArgs& args);

        void ThrowIfDeleted() const;

        void ThrowIfExternal(bool checkIfDeleted = true) const;

        void AcceptValue(std::string rawValue, const TControlValueHandler& callback);

    public:
        TControl(TControlArgs&& args);

        // Gets device-owner
        PDevice GetDevice() const;

        // Checks whether control is complete (all required metadata received)
        bool IsComplete() const;

        // Checks whether control has retained value
        // (which is not true for button types or something).
        bool IsRetained() const;

        // Checks whether control belongs to virtual device
        bool IsVirtual() const;

        // Checks whether user wants to load previous value for local control
        bool DoLoadPrevious() const;

        // generic getters
        const std::string& GetId() const;          // Gets control id (/devices/+/controls/[id])
        const std::string& GetDescription() const; // Gets control description (/meta/description)
        const std::string& GetType() const;     // Gets control type string (/meta/type) (TODO: special type for this)
        const std::string& GetUnits() const;    // Gets control value units (/meta/units)
        bool IsReadonly() const;                // Checks whether control is read only
        const std::string& GetError() const;    // Gets control error (/meta/error)
        int GetOrder() const;                   // Gets control order (or -1 for auto) (/meta/order)
        TAny GetValue() const;                  // Gets control value (converted according to type)
        const std::string& GetRawValue() const; // Gets control value string
        const TAny& GetUserData() const;        // Gets user data assigned to control during creation
        double GetPrecision() const;            // Gets control precision (/meta/precision)

        // generic setters
        void SetDescription(std::string description);
        void SetUnits(std::string units);
        void SetReadonly(bool readonly);
        void SetOrder(int order);

        // Sets '/meta/error' value for local devices
        TFuture<void> SetError(const PDriverTx& tx, const std::string& error);

        // universal interface for UpdateRawValue and SetRawOnValue
        TFuture<void> SetRawValue(const PDriverTx& tx, const std::string& value);

        // universal interface for UpdateValue and SetOnValue
        TFuture<void> SetValue(const PDriverTx& tx, TAny&& value);

        /**
         * @brief UpdateRawValue is a user interface for setting new value for local control.
         *        New value will be set after notification.
         *        Works only in transaction context.
         *        Clears /meta/error.
         */
        TFuture<void> UpdateRawValue(const PDriverTx& tx, const std::string& rawValue);

        /**
         * @brief Updates control value for local device and sets error simultaneously
         *        New value will be set after notification.
         *        Works only in transaction context.
         *        Clears /meta/error, if error string is empty.
         */
        TFuture<void> UpdateRawValueAndError(const PDriverTx& tx, const std::string& value, const std::string& error);

        /**
         * @brief UpdateValue is a user interface for setting new value for local control.
         *        New value will be set after notification.
         *        Works only in transaction context.
         *        Clears /meta/error.
         */
        TFuture<void> UpdateValue(const PDriverTx& tx, TAny&& value);

        /**
         * @brief Updates control value for local device and sets error simultaneously
         *        New value will be set after notification.
         *        Works only in transaction context.
         *        Clears /meta/error, if error string is empty.
         */
        TFuture<void> UpdateValueAndError(const PDriverTx& tx, TAny&& value, const std::string& error);

        // Sets '/on' value for external devices
        TFuture<void> SetRawOnValue(const PDriverTx& tx, const std::string& rawValue);

        // Sets '/on' value for external devices
        TFuture<void> SetOnValue(const PDriverTx& tx, TAny&& value);

        // Gets all metadata from control (for driver)
        TMetaInfo GetMeta() const;

        // Sets single meta value automatically (for driver)
        void SetSingleMeta(const std::string& meta, const std::string& value);

        // Sets new value handler (for external controls only)
        void SetValueUpdateHandler(TControlValueHandler handler);

        // Sets new 'on' value handler (for local controls only)
        void SetOnValueReceiveHandler(TControlValueHandler handler);

        // Marks control as deleted
        // Used by LocalDevice in RemoveControl
        void MarkDeleted();

        // Sets control local parent device
        // Used for reowning
        void SetLocalDevice(const PLocalDevice& device);

        //
        // Methods to accept values from Mqtt, called generally by driver
        void AcceptValue(const std::string& rawValue);
        void AcceptOnValue(const std::string& rawValue);
        void AcceptMeta(const PDriverTx& tx, const TNewExternalDeviceControlMetaEvent& event);

        // Internal storage is flushed on disk after the control change
        bool IsDurable() const;

        //! Get all acceptable unit types
        static std::vector<std::string> GetUnitTypes();

    private:
        class TPrivateData;
        std::unique_ptr<TPrivateData> Pd;
    };

    PControl NewControl(TControlArgs&& args);
}

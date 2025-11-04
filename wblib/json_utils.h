#pragma once

#include <unordered_map>
#include <unordered_set>

#include "wblib/gcc_attributes.h"
#include "wblib/utils.h"
#include "json/json.h"

namespace WBMQTT
{
    class TLogger;

    namespace JSON
    {
        /**
         * @brief Validate JSON against schema. Throws std::runtime_error on validation error.
         *
         * @param root JSON to validate
         * @param jsonSchema JSON Schema
         */
        DLL_PUBLIC void Validate(const Json::Value& root, const Json::Value& jsonSchema);

        /**
         * @brief Class-validator against JSON schema.
         * For performance reasons it is better for multiple validations against same schema.
         *
         */
        class DLL_PUBLIC TValidator
        {
            struct TPrivateData;

            std::unique_ptr<TPrivateData> PrivateData;

        public:
            /**
             * @brief Construct a new TValidator object
             *
             * @param jsonSchema JSON Schema
             */
            TValidator(const Json::Value& jsonSchema);
            ~TValidator();

            /**
             * @brief Validate JSON against schema. Throws std::runtime_error on validation error.
             *
             * @param root JSON to validate
             */
            void Validate(const Json::Value& root) const;
        };

        /**
         * @brief Parse given JSON file with default settings. Throws std::runtime_error if file is invalid
         *
         * @param fileName full path and name of a file
         */
        DLL_PUBLIC Json::Value Parse(const std::string& fileName);

        /**
         * @brief Parse given JSON file with custom settings. Throws std::runtime_error if file is invalid
         *
         * @param fileName full path and name of a file
         * @param settings Json with jsoncpp lib CharReaderBuilder settings
         */
        DLL_PUBLIC Json::Value ParseWithSettings(const std::string& fileName, const Json::Value& settings);

        template<typename T> struct assert_false: std::false_type
        {};

        template<class T> inline bool Is(const Json::Value& value)
        {
            static_assert(assert_false<T>::value, "Not implemented");
            return false;
        }

        template<> inline bool Is<double>(const Json::Value& value)
        {
            return value.isDouble();
        }

        template<> bool inline Is<float>(const Json::Value& value)
        {
            return value.isDouble();
        }

        template<> bool inline Is<std::string>(const Json::Value& value)
        {
            return value.isString();
        }

        template<> bool inline Is<int32_t>(const Json::Value& value)
        {
            return value.isInt();
        }

        template<> bool inline Is<uint32_t>(const Json::Value& value)
        {
            return value.isUInt();
        }

        template<> bool inline Is<int64_t>(const Json::Value& value)
        {
            return value.isInt64();
        }

        template<> bool inline Is<uint64_t>(const Json::Value& value)
        {
            return value.isUInt64();
        }

        template<> bool inline Is<bool>(const Json::Value& value)
        {
            return value.isBool();
        }

#ifdef __EMSCRIPTEN__
        template<> bool inline Is<size_t>(const Json::Value& value)
        {
            return value.isUInt();
        }
#endif

        template<class T> inline T As(const Json::Value& value)
        {
            static_assert(assert_false<T>::value, "Not implemented");
        }

        template<> inline double As<double>(const Json::Value& value)
        {
            return value.asDouble();
        }

        template<> inline float As<float>(const Json::Value& value)
        {
            return value.asFloat();
        }

        template<> inline std::string As<std::string>(const Json::Value& value)
        {
            return value.asString();
        }

        template<> inline int32_t As<int32_t>(const Json::Value& value)
        {
            return value.asInt();
        }

        template<> inline uint32_t As<uint32_t>(const Json::Value& value)
        {
            return value.asUInt();
        }

        template<> inline int64_t As<int64_t>(const Json::Value& value)
        {
            return value.asInt64();
        }

        template<> inline uint64_t As<uint64_t>(const Json::Value& value)
        {
            return value.asUInt64();
        }

        template<> inline bool As<bool>(const Json::Value& value)
        {
            return value.asBool();
        }

#ifdef __EMSCRIPTEN__
        template<> inline unsigned long As<size_t>(const Json::Value& value)
        {
            return value.asUInt();
        }
#endif

        /**
         * @brief Generalised function to get typed values from Json::Value. It checks existence of a
         * field with specified key, defines it's type and tries to get it. Throws TBadConfigError if
         * requested type and field's type in JSON are different.
         * @tparam T type to convert to
         * @param root root item
         * @param key key of a requested field
         * @param value variable to put converted value
         * @return true - requested field exists and conversion is successful
         * @return false - requested field doesn't exist
         */
        template<class T> bool Get(const Json::Value& root, const std::string& key, T& value)
        {
            if (!root.isMember(key)) {
                return false;
            }
            Json::Value v = root[key];
            if (!Is<T>(v)) {
                throw std::runtime_error(key + " is not a " + WBMQTT::NameOfType<T>() + " value");
            }
            value = As<T>(v);
            return true;
        }

        template<> inline bool Is<std::chrono::hours>(const Json::Value& value)
        {
            return value.isInt();
        }

        template<> inline std::chrono::hours As<std::chrono::hours>(const Json::Value& value)
        {
            return std::chrono::hours(value.asInt());
        }

        template<> inline bool Is<std::chrono::minutes>(const Json::Value& value)
        {
            return value.isInt();
        }

        template<> inline std::chrono::minutes As<std::chrono::minutes>(const Json::Value& value)
        {
            return std::chrono::minutes(value.asInt());
        }

        template<> inline bool Is<std::chrono::seconds>(const Json::Value& value)
        {
            return value.isInt();
        }

        template<> inline std::chrono::seconds As<std::chrono::seconds>(const Json::Value& value)
        {
            return std::chrono::seconds(value.asInt());
        }

        template<> inline bool Is<std::chrono::milliseconds>(const Json::Value& value)
        {
            return value.isInt();
        }

        template<> inline std::chrono::milliseconds As<std::chrono::milliseconds>(const Json::Value& value)
        {
            return std::chrono::milliseconds(value.asInt());
        }

        template<> inline bool Is<std::chrono::microseconds>(const Json::Value& value)
        {
            return value.isInt();
        }

        template<> inline std::chrono::microseconds As<std::chrono::microseconds>(const Json::Value& value)
        {
            return std::chrono::microseconds(value.asInt());
        }

        template<> inline bool Is<std::chrono::nanoseconds>(const Json::Value& value)
        {
            return value.isInt();
        }

        template<> inline std::chrono::nanoseconds As<std::chrono::nanoseconds>(const Json::Value& value)
        {
            return std::chrono::nanoseconds(value.asInt());
        }

        /**
         * @brief Create Json::StreamWriter with defined parameters
         *
         * @param indentation - a string that is added before lines as indentation, "" - no indentation
         * @param commentStyle - "All" (write comments) or "None" (do not write comments)
         */
        std::unique_ptr<Json::StreamWriter> MakeWriter(const std::string& indentation = "",
                                                       const std::string& commentStyle = "None");

        //! JSON merge parameters
        struct TMergeParams
        {
            /**
             * @brief full paths to parameters that can't be overridden
             *        Example: /channels/name
             */
            std::unordered_set<std::string> ProtectedParameters;

            /**
             * @brief key - full path to array of objects,
             *        value - array's item parameter name.
             *                Items with same value of the parameter will be merged.
             *        Example: /channels - name. Channels with similar names will be merged.
             */
            std::unordered_map<std::string, std::string> MergeArraysOn;

            //! Logger for warnings
            WBMQTT::TLogger* WarnLogger = nullptr;

            //! Logger for info messages
            WBMQTT::TLogger* InfoLogger = nullptr;

            //! Prefix for log messages
            std::string LogPrefix;
        };

        /**
         * @brief
         *
         * @param dst JSON to merge to
         * @param src JSON that is going to merge
         * @param params parameters controlling merge process
         */
        void Merge(Json::Value& dst, const Json::Value& src, const TMergeParams& params);
    } // namespace JSON
} // namespace WBMQTT

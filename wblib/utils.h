#pragma once

#include "exceptions.h"
#include "thread_utils.h"

#include <iomanip>
#include <limits>
#include <memory>
#include <sstream>
#include <string>
#include <time.h>
#include <vector>

namespace WBMQTT
{
    namespace detail
    {
        // pass std::string to C - varargs as C-string
        inline const char* ForwardToVarArgs(const std::string& arg)
        {
            return arg.c_str();
        }

        template<typename T> inline const T& ForwardToVarArgs(const T& arg)
        {
            return arg;
        }

        class TScopeGuard
        {
            std::function<void()> Handler;
            uint8_t Condition;

        public:
            enum ECondition : uint8_t
            {
                ALWAYS,
                EXCEPTION_ONLY,
                NO_EXCEPTION_ONLY
            };

            explicit TScopeGuard(std::function<void()>&& handler, ECondition condition = ALWAYS);
            ~TScopeGuard() noexcept(false);
        };

        template<class T> class TScoped
        {
        protected:
            T Object;

        public:
            TScoped(T&& object): Object(std::move(object))
            {}
            TScoped(TScoped&&) = default;
            ~TScoped() = default;

            T* operator->() noexcept
            {
                return &Object;
            }
            const T* operator->() const noexcept
            {
                return &Object;
            }
        };

        std::string Demangle(const char* mangledName);
    }

    template<class T> class TScoped: public detail::TScoped<T>
    {
        using Base = detail::TScoped<T>;

    public:
        TScoped(T&& object): Base(std::move(object))
        {}
    };

    template<class T> class TScoped<std::shared_ptr<T>>: public detail::TScoped<std::shared_ptr<T>>
    {
        using Base = detail::TScoped<std::shared_ptr<T>>;

    public:
        TScoped(std::shared_ptr<T>&& object): Base(std::move(object))
        {}

        T* operator->() noexcept
        {
            return Base::Object.get();
        }
        const T* operator->() const noexcept
        {
            return Base::Object.get();
        }
    };

    template<typename Float> std::string FormatFloat(Float value)
    {
        static_assert(std::is_floating_point<Float>::value, "FormatFloat accepts only floating point values");

        std::ostringstream ss;
        ss << std::setprecision(std::numeric_limits<Float>::digits10 + 1) << value;
        return ss.str();
    }

    bool StringHasSuffix(const std::string& str, const std::string& suffix);
    bool StringStartsWith(const std::string& str, const std::string& prefix);
    std::vector<std::string> StringSplit(const std::string& s, char delim);
    std::vector<std::string> StringSplit(const std::string& s, const std::string& delim);

    std::string StringReplace(std::string subject, const std::string& search, const std::string& replace);

    void StringUpper(std::string& str);

    std::string HexDump(const uint8_t* buf, size_t count);

    template<typename... Args> std::string StringFormat(const char* format, Args... args)
    {
        size_t size = std::snprintf(nullptr, 0, format, detail::ForwardToVarArgs(args)...) + 1; // Extra space for '\0'
        std::unique_ptr<char[]> buf(new char[size]);
        std::snprintf(buf.get(), size, format, detail::ForwardToVarArgs(args)...);
        return std::string(buf.get(), buf.get() + size - 1); // We don't want the '\0' inside
    }

    template<typename... Args> std::string StringFormat(const std::string& format, Args&&... args)
    {
        return StringFormat(format.c_str(), std::forward<Args>(args)...);
    }

    template<typename T, typename... Args> std::unique_ptr<T> MakeUnique(Args&&... args)
    {
        return std::unique_ptr<T>(new T(std::forward<Args>(args)...));
    }

    template<class To, class From> std::unique_ptr<To> StaticUniqueCast(std::unique_ptr<From>&& pointer)
    {
        return std::unique_ptr<To>(static_cast<To*>(pointer.release()));
    }

    template<class To, class From> std::unique_ptr<To> DynamicUniqueCast(std::unique_ptr<From>&& pointer)
    {
        return std::unique_ptr<To>(dynamic_cast<To*>(pointer.release()));
    }

#define WB_SCOPE_EXIT(x)                                                                                               \
    ::WBMQTT::detail::TScopeGuard scopeGuard##__COUNTER__([&]() { x }, ::WBMQTT::detail::TScopeGuard::ALWAYS);
#define WB_SCOPE_THROW_EXIT(x)                                                                                         \
    ::WBMQTT::detail::TScopeGuard scopeGuardOnThrow##__COUNTER__([&]() { x },                                          \
                                                                 ::WBMQTT::detail::TScopeGuard::EXCEPTION_ONLY);
#define WB_SCOPE_NO_THROW_EXIT(x)                                                                                      \
    ::WBMQTT::detail::TScopeGuard scopeGuardOnNoThrow##__COUNTER__([&]() { x },                                        \
                                                                   ::WBMQTT::detail::TScopeGuard::NO_EXCEPTION_ONLY);

    /* polymorphic */
    template<class T> std::string NameOfType(T&& obj)
    {
        return detail::Demangle(typeid(std::forward<T>(obj)).name());
    }

    /* static */
    template<class T> std::string NameOfType()
    {
        return detail::Demangle(typeid(T).name());
    }

    template<typename... Args> std::unique_ptr<std::thread> MakeThread(const std::string& name,
                                                                       const std::function<void(Args&&...)> threadFunc,
                                                                       Args&&... args)
    {
        return MakeUnique<std::thread>(
            [=](Args&&... _args) {
                SetThreadName(name);
                try {
                    threadFunc(std::forward<Args>(_args)...);
                } catch (TBaseException& e) {
                    detail::LogThreadException(name, e);
                    throw;
                } catch (std::exception& e) {
                    detail::LogThreadException(name, e);
                    throw;
                } catch (...) {
                    detail::LogThreadException(name);
                    throw;
                }
            },
            std::forward<Args>(args)...);
    }

#define WB_EXC_ARGS(exception_t, ...) exception_t(__FILE__, __LINE__, __VA_ARGS__)
#define WB_EXC_NO_ARGS(exception_t) exception_t(__FILE__, __LINE__)

#define GET_ARG(arg1, arg2, arg3, arg4, arg5, arg6, ...) arg6
#define WB_EXC_MACRO_CHOOSER(...)                                                                                      \
    GET_ARG(__VA_ARGS__, WB_EXC_ARGS, WB_EXC_ARGS, WB_EXC_ARGS, WB_EXC_ARGS, WB_EXC_NO_ARGS, )

#define wb_exception(...) WB_EXC_MACRO_CHOOSER(__VA_ARGS__)(__VA_ARGS__)
#define wb_throw(...) throw wb_exception(__VA_ARGS__)
}

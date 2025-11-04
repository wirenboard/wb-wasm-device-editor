#pragma once

#include <functional>
#include <thread>

#ifdef __GNUG__
#define GCC_VERSION (__GNUC__ * 10000 + __GNUC_MINOR__ * 100 + __GNUC_PATCHLEVEL__)
#if GCC_VERSION < 40800 && !defined(__EMSCRIPTEN__)
#define thread_local __thread
#endif
#endif

namespace WBMQTT
{
    namespace detail
    {
        void LogThreadException(const std::string& name);
        void LogThreadException(const std::string& name, const std::exception& e);
    }

    void SetThreadName(const std::string& name);
    const std::string& GetThreadName();
}

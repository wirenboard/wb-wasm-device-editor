#pragma once

#include <thread>

namespace WBMQTT
{
    using ThreadId = std::thread::id;

    class TBaseLockObject
    {
        ThreadId* CurrentOwner;

    public:
        TBaseLockObject(ThreadId& currentOwner, const char* subclassName);
        void Lock();
        void Unlock();
    };
}

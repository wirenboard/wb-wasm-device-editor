#pragma once

#include "base_lock_object.h"

#include <atomic>
#include <iostream>
#include <mutex>
#include <string>

namespace WBMQTT
{
    class TLogger
    {
    public:
        struct HexDump
        {
            const uint8_t* Data;
            size_t Count;

            HexDump(const uint8_t* buf, size_t count);
            template<typename T> HexDump(const T& obj): HexDump(&obj, sizeof(T))
            {}
            void Write(std::ostream& output);
        };

    private:
        struct TLoggerTx: private TBaseLockObject
        {
            TLoggerTx(TLogger&);
            TLoggerTx(const TLoggerTx&) = delete;
            TLoggerTx(TLoggerTx&&) = default;
            ~TLoggerTx();

            template<class T> TLoggerTx& operator<<(const T& message)
            {
                if (CanWrite()) {
                    Logger.Output.Stream << message;
                }
                return *this;
            }

            TLoggerTx& operator<<(HexDump&& hex);

        private:
            bool CanWrite() const;

            TLogger& Logger;
            std::unique_lock<std::mutex> Lock;
            std::ios::fmtflags OldState;
        };

        friend TLoggerTx;

    public:
        enum
        {
            BLACK,
            BLUE,
            GREEN,
            CYAN,
            RED,
            MAGENTA,
            BROWN,
            GREY,
            DARKGREY,
            LIGHTBLUE,
            LIGHTGREEN,
            LIGHTCYAN,
            LIGHTRED,
            LIGHTMAGENTA,
            YELLOW,
            WHITE
        };

        enum EColorUsage : uint8_t
        {
            ON,
            OFF,
            AUTO
        };

        struct TOutput
        {
            explicit TOutput(std::ostream& stream, FILE* file = nullptr);

            const bool IsTTY;
            std::ostream& Stream;
            std::mutex Mutex;
            ThreadId CurrentOwner;
        };

        static TOutput StdErr;
        static TOutput StdOut;

        TLogger(std::string prefix,
                TOutput& output,
                int color = -1,
                bool enabled = true,
                EColorUsage colorUsage = AUTO);

        void SetEnabled(bool enabled);

        void SetUseColor(EColorUsage colorUsage);
        bool IsUsingColor() const;

        static void SetColoredThreads(bool enabled);
        static void SetColorEnabled(bool enabled);

        bool IsEnabled() const;

        TLoggerTx Log();

    private:
        void ApplyColor();
        void ResetColor();

        static std::atomic_bool ColoredThreads, ColorEnabled;

        std::atomic_bool Enabled;
        std::atomic<EColorUsage> ColorUsage;
        std::string Prefix;
        TOutput& Output;
        int OutputColor;
    };

    extern TLogger Error;
    extern TLogger Warn;
    extern TLogger Info;
    extern TLogger Debug;
}

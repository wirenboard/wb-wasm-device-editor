#pragma once

#include "exceptions.h"
#include "utils.h"

#include <atomic>
#include <condition_variable>
#include <memory>
#include <mutex>
#include <thread>

namespace WBMQTT
{
    template<class T> class TPromise;

    namespace detail
    {
        template<class T> class TPromiseBase;

        // value interface
        template<typename T> struct TValue
        {
            virtual bool IsException() const = 0;
            virtual T Get() const = 0;
            virtual ~TValue()
            {}
        };

        // created when we want to pass exception via promise
        template<typename T, typename E> struct TExceptionWrapper: public TValue<T>
        {
            TExceptionWrapper(E&& exception): Exception(std::forward<E>(exception))
            {}
            bool IsException() const override
            {
                return true;
            }
            T Get() const override
            {
                throw Exception;
            }

        private:
            E Exception;
        };

#ifdef _EXCEPTION_PTR_H
        // std::exception_ptr specialization for std::current_exception support
        template<typename T> struct TExceptionWrapper<T, std::exception_ptr>: public TValue<T>
        {
            TExceptionWrapper(std::exception_ptr&& exception): Exception(std::move(exception))
            {}
            bool IsException() const override
            {
                return true;
            }
            T Get() const override
            {
                std::rethrow_exception(Exception);
            }

        private:
            std::exception_ptr Exception;
        };
#endif

        template<typename T> struct TFunctionWrapper: public TValue<T>
        {
            TFunctionWrapper(const std::function<T()>& function): Function(function)
            {}
            bool IsException() const override
            {
                return false;
            }
            T Get() const override
            {
                return Function();
            }

        private:
            std::function<T()> Function;
        };

        // created when we want to pass actual value via promise
        template<typename T> struct TValueWrapper: public TValue<T>
        {
            TValueWrapper(const T& value): Value(value)
            {}
            bool IsException() const override
            {
                return false;
            }
            T Get() const override
            {
                return Value;
            }

        private:
            T Value;
        };

        // created when we want just to sync via promise
        template<> struct TValueWrapper<void>: public TValue<void>
        {
            bool IsException() const override
            {
                return false;
            }
            void Get() const override
            {}
        };

        template<class T> class TDataBase
        {
            friend class TPromiseBase<T>;

        public:
            TDataBase(): Ready(false), Broken(false), Value(nullptr)
            {}

            bool IsReady() const
            {
                return Ready.load();
            }

            bool IsBroken() const
            {
                return Broken.load();
            }

            bool IsException() const
            {
                Wait();
                return Value->IsException();
            }

            void Wait() const
            {
                std::unique_lock<std::mutex> lock(Mutex);
                ConditionVariable.wait(lock, [this] { return Ready.load() || Broken.load(); });
                if (Broken.load()) {
                    wb_throw(TBrokenPromiseException,
                             "Promise is broken, probably TPromise object was deleted before SetValue call");
                }
            }

            template<class Rep, class Period> bool WaitFor(const std::chrono::duration<Rep, Period>& timeout) const
            {
                std::unique_lock<std::mutex> lock(Mutex);
                if (ConditionVariable.wait_for(lock, timeout, [this] { return Ready.load() || Broken.load(); })) {
                    if (Broken.load()) {
                        wb_throw(TBrokenPromiseException,
                                 "Promise is broken, probably TPromise object was deleted before SetValue call");
                    }
                    return true;
                }
                return false;
            }

            T GetValue() const
            {
                Wait();
                return Value->Get();
            }

            template<typename E> void SetException(E&& exception)
            {
                if (Ready.load()) {
                    wb_throw(TPromiseRepeatedAssignmentException, "SetXXX(...) must be called once!");
                }
                std::lock_guard<std::mutex> lock(Mutex);
                Value = MakeUnique<TExceptionWrapper<T, E>>(std::forward<E>(exception));
                Ready.store(true);
                ConditionVariable.notify_all();
            }

            void SetFunction(const std::function<T()>& function)
            {
                if (Ready.load()) {
                    wb_throw(TPromiseRepeatedAssignmentException, "SetXXX(...) must be called once!");
                }
                std::lock_guard<std::mutex> lock(Mutex);
                Value = MakeUnique<TFunctionWrapper<T>>(function);
                Ready.store(true);
                ConditionVariable.notify_all();
            }

        protected:
            using PValue = std::unique_ptr<TValue<T>>;

            void HandlePromiseDestruction()
            {
                if (!Ready.load()) {
                    Broken.store(true);
                }
            }

            mutable std::mutex Mutex;
            mutable std::condition_variable ConditionVariable;
            std::atomic_bool Ready, Broken;

            PValue Value;
        };

        template<class T> class TDataGeneric: public TDataBase<T>
        {
            using Base = TDataBase<T>;

        public:
            void SetValue(const T& value)
            {
                if (Base::Ready.load()) {
                    wb_throw(TPromiseRepeatedAssignmentException, "SetXXX(...) must be called once!");
                }
                std::lock_guard<std::mutex> lock(Base::Mutex);
                Base::Value = MakeUnique<TValueWrapper<T>>(value);
                Base::Ready.store(true);
                Base::ConditionVariable.notify_all();
            }
        };

        template<> class TDataGeneric<void>: public TDataBase<void>
        {
            using Base = TDataBase<void>;

        public:
            void Notify()
            {
                if (Base::Ready.load()) {
                    return;
                }
                std::lock_guard<std::mutex> lock(Base::Mutex);
                Base::Value = MakeUnique<TValueWrapper<void>>();
                Base::Ready.store(true);
                Base::ConditionVariable.notify_all();
            }
        };

        /*!
         * Future for TPromise
         *
         * All methods throw exception, if future is not assigned to value generated by
         * TPromise<...>::TFuture::Future::GetFuture()
         */
        template<class T> class TFutureBase: protected std::shared_ptr<TDataGeneric<T>>
        {
        public:
            /// Only move contructor
            TFutureBase(TFutureBase&&) = default;

            TFutureBase& operator=(TFutureBase&&) = default;

            /// Checks if promise is fulfilled
            bool IsReady() const
            {
                if (!*this)
                    wb_throw(TPromiseFutureException, "Call IsReady() from uninitialised TPromise<...>::TFuture!");
                return this->get()->IsReady();
            }

            /// Checks if promise is broken (TPromise object was destructed before SetValue call)
            bool IsBroken() const
            {
                if (!*this)
                    wb_throw(TPromiseFutureException, "Call IsBroken() from uninitialised TPromise<...>::TFuture!");
                return this->get()->IsBroken();
            }

            void Wait() const
            {
                if (!*this)
                    wb_throw(TPromiseFutureException, "Call Wait() from uninitialised TPromise<...>::TFuture!");
                this->get()->Wait();
            }

            template<class Rep, class Period> bool WaitFor(const std::chrono::duration<Rep, Period>& timeout) const
            {
                if (!*this)
                    wb_throw(TPromiseFutureException, "Call Wait() from uninitialised TPromise<...>::TFuture!");
                return this->get()->WaitFor(timeout);
            }

            bool IsException() const
            {
                if (!*this)
                    wb_throw(TPromiseFutureException, "Call IsException() from uninitialised TPromise<...>::TFuture!");
                return this->get()->IsException();
            }

        protected:
            /// Constructor, used by TPromiseBase and TPromise only
            TFutureBase(std::shared_ptr<TDataGeneric<T>> data): std::shared_ptr<TDataGeneric<T>>(data)
            {}
        };

        template<class T> class TFutureGeneric: public TFutureBase<T>
        {
            friend class TPromiseBase<T>;
            friend class TPromise<T>;

            using Base = TFutureBase<T>;
            explicit TFutureGeneric(std::shared_ptr<TDataGeneric<T>> data): Base(data)
            {}

        public:
            TFutureGeneric(TFutureGeneric&&) = default;

            TFutureGeneric& operator=(TFutureGeneric&&) = default;
            /// Waits and returns value. If promise is broken than throws exception
            T GetValue()
            {
                if (!*this)
                    wb_throw(TPromiseFutureException, "Call GetValue() from uninitialised TPromise<...>::TFuture!");
                return this->get()->GetValue();
            }

            /// Needed to be able to capture future by lambda
            /// because move capture (via generalized lambda capture) is C++14 feature
            std::shared_ptr<TFutureGeneric> Share()
            {
                return std::make_shared<TFutureGeneric>(std::move(*this));
            }
        };

        template<> class TFutureGeneric<void>: public TFutureBase<void>
        {
            friend class TPromiseBase<void>;
            friend class TPromise<void>;

            using Base = TFutureBase<void>;
            TFutureGeneric(std::shared_ptr<TDataGeneric<void>> data): Base(data)
            {}

        public:
            TFutureGeneric(TFutureGeneric&&) = default;

            TFutureGeneric& operator=(TFutureGeneric&&) = default;
            /// Waits and returns value. If promise is broken than throws exception
            void Sync()
            {
                if (!*this)
                    wb_throw(TPromiseFutureException, "Call GetValue() from uninitialised TPromise<...>::TFuture!");
                this->get()->GetValue();
            }

            /// Needed to be able to capture future by lambda
            /// because move capture (via generalized lambda capture) is C++14 feature
            std::shared_ptr<TFutureGeneric> Share()
            {
                return std::make_shared<TFutureGeneric>(std::move(*this));
            }
        };

        /*!
         *  TPromise<T>::TFuture::Future
         *
         *  Simple replacement for c++ std::promise and std::future
         *
         *  Introduced because of inability to compile std::future by g++-4.7
         *
         */
        template<typename T> class TPromiseBase
        {
        protected:
            using TData = TDataGeneric<T>;

            explicit TPromiseBase(const std::shared_ptr<TData>& data): Data(data)
            {}

        public:
            using TFuture = TFutureGeneric<T>;

            /// Creates new promise
            TPromiseBase(): Data(std::make_shared<TData>())
            {}

            /// Only move contructor
            TPromiseBase(TPromiseBase&&) = default;

            TPromiseBase& operator=(TPromiseBase&&) = default;

            /// Destructor that does nothing special, but marks promise as broken if it is not ready
            ~TPromiseBase()
            {
                // Data may be stealed in move constructor
                if (Data)
                    Data->HandlePromiseDestruction();
            }

            /// Creates a future object
            TFuture GetFuture()
            {
                if (!Data)
                    wb_throw(TPromiseException, "Call GetFuture(...) from uninitialised TPromise<...>::TFuture");
                return TFuture(Data);
            }

            // Static methods are in case if result available without async operation
            template<typename E> static TFuture GetExceptionFuture(E&& exception)
            {
                auto data = std::make_shared<TData>();
                data->SetException(std::forward<E>(exception));
                return TFuture(data);
            }

            template<typename E> void Throw(E&& exception)
            {
                if (!Data)
                    wb_throw(TPromiseException, "Call SetException(...) from uninitialised TPromise<...>::TFuture");
                Data->SetException(std::forward<E>(exception));
            }

            void SetFunction(std::function<T()> function)
            {
                if (!Data)
                    wb_throw(TPromiseException, "Call SetFunction(...) from uninitialised TPromise<...>::TFuture");
                Data->SetFunction(function);
            }

            bool IsFulfilled() const
            {
                return Data->IsReady();
            }

            bool IsWaited()
            {
                if (Data->Mutex.try_lock()) {
                    Data->Mutex.unlock();
                    return false;
                }
                return true;
            }

            operator bool() const
            {
                return bool(Data);
            }

            static TFuture GetFutureFromFunction(std::function<T()> function)
            {
                auto data = std::make_shared<TData>();
                data->SetFunction(function);
                return TFuture(data);
            }

        protected:
            std::shared_ptr<TData> Data;
        };
    }

    template<typename T> class TPromise: public detail::TPromiseBase<T>
    {
        using Base = detail::TPromiseBase<T>;

        explicit TPromise(const std::shared_ptr<typename Base::TData>& data): Base(data){};

    public:
        TPromise() = default;

        TPromise(TPromise&&) = default;

        TPromise& operator=(TPromise&&) = default;

        void SetValue(const T& value)
        {
            if (!Base::Data)
                wb_throw(TPromiseException, "Call SetValue(...) from uninitialised TPromise<...>::TFuture");
            Base::Data->SetValue(value);
        }

        // Static methods are in case if result available without async operation
        static typename Base::TFuture GetValueFuture(const T& value)
        {
            auto data = std::make_shared<typename Base::TData>();
            data->SetValue(value);
            return typename Base::TFuture(data);
        }

        static TPromise Null()
        {
            return TPromise(nullptr);
        }
    };

    template<> class TPromise<void>: public detail::TPromiseBase<void>
    {
        using Base = detail::TPromiseBase<void>;

        explicit TPromise(const std::shared_ptr<typename Base::TData>& data): Base(data){};

    public:
        TPromise() = default;

        TPromise(TPromise&&) = default;

        TPromise& operator=(TPromise&&) = default;

        void Complete()
        {
            if (!Base::Data)
                wb_throw(TPromiseException, "Call SetValue(...) from uninitialised TPromise<...>::TFuture");
            Base::Data->Notify();
        }

        // Static methods are in case if result available without async operation
        static typename Base::TFuture GetCompletedFuture()
        {
            auto data = std::make_shared<Base::TData>();
            data->Notify();
            return Base::TFuture(data);
        }

        static TPromise Null()
        {
            return TPromise(nullptr);
        }
    };

    template<class T> using TFuture = typename TPromise<T>::TFuture;
}

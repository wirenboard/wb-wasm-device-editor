#pragma once
#include "exceptions.h"
#include "utils.h"

#include <cstring>
#include <limits>
#include <typeindex>
#include <typeinfo>
#include <unordered_map>

namespace WBMQTT
{
    namespace detail
    {
        class ITypeWrapper
        {
            virtual bool IsSame(const std::type_info& type) = 0;

        public:
            template<typename T> bool IsSame()
            {
                return IsSame(typeid(T));
            }
            virtual void Copy(void* memory, const void* object) = 0;
            virtual void Move(void* memory, void* object) noexcept = 0;
            virtual void Destroy(void* object) noexcept = 0;
            virtual std::string GetName() = 0;
            virtual ~ITypeWrapper() = default;
        };

        template<class T> class TTypeWrapper: public ITypeWrapper
        {
            bool IsSame(const std::type_info& type) override
            {
                return typeid(T) == type;
            }

            TTypeWrapper()
            {}

        public:
            void Copy(void* memory, const void* object) override
            {
                new (memory) T(*static_cast<const T*>(object));
            }

            void Move(void* memory, void* object) noexcept override
            {
                new (memory) T(std::move(*static_cast<T*>(object)));
            }

            void Destroy(void* object) noexcept override
            {
                static_cast<T*>(object)->~T();
            }

            std::string GetName() override
            {
                return NameOfType<T>();
            }

            static ITypeWrapper* Get()
            {
                static std::unordered_map<std::type_index, std::unique_ptr<ITypeWrapper>> cache;

                auto& pInstance = cache[std::type_index(typeid(T))];

                if (!pInstance) {
                    pInstance = std::unique_ptr<ITypeWrapper>(new TTypeWrapper());
                }

                return pInstance.get();
            }
        };
    }

    struct TMallocAllocator
    {
        inline static void* Allocate(std::size_t size)
        {
            return malloc(size);
        }

        inline static void Free(void* memory)
        {
            free(memory);
        }
    };

    /*!
     * Allows to store values of any type.
     * Note:
     *  TAnyBasic move doesn't trigger move constructor of held object
     *    explanation:
     *      we are moving ownership of object to another TAnyBasic,
     *      but not to another object of the same type, thus no need to call move constructor
     *
     *  TAnyBasic copy, on contrary, does trigger copy constructor of held object
     *   since copy of held object needs to be created.
     */
    template<class Allocator = TMallocAllocator> class TAnyBasic
    {
        union
        {
            // Resulting size is determined by size of
            // this struct: we need pointer, size and flag
            struct
            {
                void* Memory;
                std::size_t Size;
                bool _;
            } Dynamic;

            // Small object optimization
            struct
            {
                uint8_t Memory[sizeof Dynamic - 2];
                uint8_t Size;
                bool _;
                static_assert(sizeof Memory <= std::numeric_limits<decltype(Size)>::max(),
                              "Static.Memory size can exceed Static.Size max, which will lead to overflow");
            } Static;

            // Flag is last byte
            struct
            {
                uint8_t _[sizeof Dynamic - 1];
                bool IsDynamic; // Owns memory on heap?
            } Memory;

        } Inner;

        detail::ITypeWrapper* Type;

        // ---- inner utils ----
        inline const TAnyBasic* c_this() const noexcept
        {
            return this;
        }

        template<typename> struct is_any: std::false_type
        {};

        template<typename T> struct is_any<TAnyBasic<T>>: std::true_type
        {};

#define not_lvalue_ref(T) class = typename std::enable_if<!std::is_lvalue_reference<T>::value>::type
#define of_other_type(T) class = typename std::enable_if<!is_any<T>::value>::type
        // ---- inner utils end ----

        inline void Reset() noexcept
        {
            Type = nullptr;
            Inner.Memory.IsDynamic = false;
            Inner.Static.Size = 0;
        }

        inline void InitDynamic(std::size_t size)
        {
            Inner.Dynamic.Memory = Allocator::Allocate(size);
            Inner.Dynamic.Size = size;
            Inner.Memory.IsDynamic = true;
        }

        inline void InitStatic(uint8_t size)
        {
            Inner.Static.Size = size;
            Inner.Memory.IsDynamic = false;
        }

        inline void CopyDynamic(const void* object, std::size_t size)
        {
            InitDynamic(size);
            Type->Copy(Inner.Dynamic.Memory, object);
        }

        inline void CopyStatic(const void* object, uint8_t size)
        {
            InitStatic(size);
            Type->Copy(Inner.Static.Memory, object);
        }

        inline void MoveDynamic(void* object, std::size_t size)
        {
            InitDynamic(size);
            Type->Move(Inner.Dynamic.Memory, object);
        }

        inline void MoveStatic(void* object, uint8_t size) noexcept
        {
            InitStatic(size);
            Type->Move(Inner.Static.Memory, object);
        }

        inline void AssignDynamic(void* data, std::size_t size) noexcept
        {
            Inner.Dynamic.Memory = data;
            Inner.Dynamic.Size = size;

            Inner.Memory.IsDynamic = true;
        }

        inline void AssignStatic(const void* object, uint8_t size) noexcept
        {
            InitStatic(size);
            memcpy(Inner.Static.Memory, object, size);
        }

        template<typename T> inline void Copy(const T& object)
        {
            Type = detail::TTypeWrapper<T>::Get();

            if (sizeof(T) > StaticCapacity()) {
                CopyDynamic(&object, sizeof object);
            } else {
                CopyStatic(&object, sizeof object);
            }
        }

        inline void Copy(const TAnyBasic& other)
        {
            if (!other) {
                return;
            }

            Type = other.Type;

            if (other.Inner.Memory.IsDynamic) {
                CopyDynamic(other.Inner.Dynamic.Memory, other.Inner.Dynamic.Size);
            } else {
                CopyStatic(other.Inner.Static.Memory, other.Inner.Static.Size);
            }
        }

        template<typename T> inline void Move(T&& object)
        {
            Type = detail::TTypeWrapper<T>::Get();

            if (sizeof(T) > StaticCapacity()) {
                MoveDynamic(&object, sizeof object);
            } else {
                MoveStatic(&object, sizeof object);
            }
        }

        inline void Move(TAnyBasic&& other) noexcept
        {
            if (!other) {
                return;
            }

            Type = other.Type;

            if (other.Inner.Memory.IsDynamic) {
                AssignDynamic(other.Inner.Dynamic.Memory, other.Inner.Dynamic.Size);
            } else {
                AssignStatic(other.Inner.Static.Memory, other.Inner.Static.Size);
            }

            other.Reset();
        }

        template<typename T, typename... Args> inline T& EmplaceUnsafe(Args&&... args)
        {
            Type = detail::TTypeWrapper<T>::Get();

            if (sizeof(T) > StaticCapacity()) {
                InitDynamic(sizeof(T));
            } else {
                InitStatic(sizeof(T));
            }

            new (Data()) T(std::forward<Args>(args)...);

            return As<T>();
        }

        inline void DeleteDirty() noexcept
        {
            if (!Empty()) {
                Type->Destroy(Data());
                if (Inner.Memory.IsDynamic) {
                    Allocator::Free(Inner.Dynamic.Memory);
                }
            }
        }

    public:
        TAnyBasic()
        {
            Reset();
        }

        template<typename T> TAnyBasic(const T& object): TAnyBasic()
        {
            Copy(object);
        }

        template<typename T, not_lvalue_ref(T), of_other_type(T)> TAnyBasic(T&& object): TAnyBasic()
        {
            Move(std::move(object));
        }

        // Treat C array as C++ array
        template<typename T, int N> TAnyBasic(const T (&c_array)[N])
        {
            auto& array = EmplaceUnsafe<std::array<T, N>>();
            std::copy(std::begin(c_array), std::end(c_array), array.begin());
        }

        // Treat C string as C++ string
        TAnyBasic(const char* c_string): TAnyBasic(std::string(c_string))
        {}

        // Invokes T's copy constructor
        TAnyBasic(const TAnyBasic& other): TAnyBasic()
        {
            Copy(other);
        }

        // Does not invoke T's move constructor
        TAnyBasic(TAnyBasic&& other) noexcept: TAnyBasic()
        {
            Move(std::move(other));
        }

        static std::size_t StaticCapacity()
        {
            return sizeof(Inner.Static.Memory);
        }

        template<typename T, typename... Args> inline T& Emplace(Args&&... args)
        {
            Clean();
            return EmplaceUnsafe<T>(std::forward<Args>(args)...);
        }

        template<typename T> T& operator=(const T& object)
        {
            Clean();
            Copy(object);
            return As<T>();
        }

        template<typename T, not_lvalue_ref(T), of_other_type(T)> T& operator=(T&& object)
        {
            Clean();
            Move(std::move(object));
            return As<T>();
        }

        template<typename T, int N> std::array<T, N>& operator=(T (&c_array)[N])
        {
            Clean();
            auto& array = EmplaceUnsafe<std::array<T, N>>();
            std::copy(std::begin(c_array), std::end(c_array), array.begin());
            return array;
        }

        std::string& operator=(const char* c_string)
        {
            return operator=(std::string(c_string));
        }

        TAnyBasic& operator=(const TAnyBasic& rhs)
        {
            if (&rhs != this) {
                Clean();
                Copy(rhs);
            }
            return *this;
        }

        TAnyBasic& operator=(TAnyBasic&& rhs) noexcept
        {
            if (&rhs != this) {
                Clean();
                Move(std::move(rhs));
            }
            return *this;
        }

        operator bool() const
        {
            return !Empty();
        }

        std::size_t GetSize() const
        {
            if (Inner.Memory.IsDynamic) {
                return Inner.Dynamic.Size;
            } else {
                return Inner.Static.Size;
            }
        }

        const void* Data() const
        {
            return Inner.Memory.IsDynamic ? static_cast<const void*>(Inner.Dynamic.Memory)
                                          : static_cast<const void*>(Inner.Static.Memory);
        }

        void* Data()
        {
            return const_cast<void*>(c_this()->Data());
        }

        template<typename T> bool Is() const
        {
            return Type && Type->IsSame<T>();
        }

        template<typename T> const T& As() const
        {
            if (Empty()) {
                wb_throw(TAnyEmptyError);
            }

            if (!Is<T>()) {
                wb_throw(TAnyTypesMismatchError, Type->GetName(), NameOfType<T>());
            }

            return *static_cast<const T*>(Data());
        }

        template<typename T> T& As()
        {
            return const_cast<T&>(c_this()->template As<T>());
        }

        void Clean()
        {
            DeleteDirty();
            Reset();
        }

        bool Empty() const
        {
            return !Type;
        }

        ~TAnyBasic() noexcept
        {
            DeleteDirty();
        }
    };

#undef not_lvalue_ref
#undef of_other_type

    using TAny = TAnyBasic<>;
}

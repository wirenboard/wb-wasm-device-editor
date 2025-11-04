#pragma once

#include <unordered_map>

namespace WBMQTT
{
    template<class K, class V> using TMap = std::unordered_map<K, V>;
}
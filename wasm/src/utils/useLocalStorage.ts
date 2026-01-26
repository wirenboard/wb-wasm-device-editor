import { useEffect, useState } from 'react';

export const useLocalStorage = (key: string) => {
  const getItems = () => {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : [];
    } catch {
      return [];
    }
  };

  const [items, setItems] = useState(getItems);

  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === key) {
        setItems(getItems());
      }
    };

    window.addEventListener('storage', onStorage);

    return () => {
      window.removeEventListener('storage', onStorage);
    };
  }, []);

  const updateItems = (items) => {
    localStorage.setItem(key, JSON.stringify(items));
    window.dispatchEvent(new StorageEvent('storage', { key }));
  };

  return [items, updateItems];
};

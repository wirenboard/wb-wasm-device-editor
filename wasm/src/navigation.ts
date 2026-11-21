/**
 * The editor has two views and no router. The location hash is enough to switch
 * between them, and it survives a reload — which matters for a tool distributed
 * as one HTML file opened from disk.
 */

export const DALI_HASH = '#dali';

export const openDali = () => {
  window.location.hash = DALI_HASH;
};

export const closeDali = () => {
  window.location.hash = '';
};

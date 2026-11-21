import { beforeEach, describe, expect, it } from 'vitest';
import { clearInstallation, loadInstallation, saveInstallation } from './persistence';

describe('installation persistence', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('round-trips config, scenario and groups', () => {
    saveInstallation({
      config: '{"gateways": []}',
      scenario: { gateways: [{ id: 'wb-dali_17', slaveId: 17, buses: {} }] },
      groups: '{"wb-dali_17_bus_1_4": [1, 5]}',
    });
    const loaded = loadInstallation();
    expect(loaded?.config).toBe('{"gateways": []}');
    expect(loaded?.groups).toBe('{"wb-dali_17_bus_1_4": [1, 5]}');
    expect((loaded?.scenario as any).gateways[0].slaveId).toBe(17);
  });

  it('treats a corrupt entry as nothing saved rather than failing the page', () => {
    window.localStorage.setItem('wb-dali-installation-hardware', '{not json');
    expect(loadInstallation()).toBeNull();
  });

  it('clears', () => {
    saveInstallation({ config: '{}', scenario: null });
    clearInstallation();
    expect(loadInstallation()).toBeNull();
  });
});

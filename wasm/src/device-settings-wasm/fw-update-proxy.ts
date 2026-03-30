import type {
  FwUpdateProxy,
  FwUpdateProxyGetFirmwareInfoParams,
  FwUpdateProxyGetFirmwareInfoResult,
  FwUpdateProxyUpdateParams,
  FwUpdateProxyClearErrorParams,
  FwUpdateProxyRestoreParams,
} from '@/stores/device-manager/types';

declare const Module: {
  request(type: string, data: unknown): Promise<{ error?: { message: string }; result?: unknown }>;
};

export class WasmFwUpdateProxy implements FwUpdateProxy {
  private _isOffline: () => boolean;

  constructor(isOffline: () => boolean) {
    this._isOffline = isOffline;
  }

  private requireOnline() {
    if (this._isOffline()) {
      throw new Error('Firmware operations require an internet connection');
    }
  }

  async hasMethod(method: string): Promise<boolean> {
    return ['GetFirmwareInfo', 'Update', 'ClearError', 'Restore'].includes(method);
  }

  async GetFirmwareInfo(
    params: FwUpdateProxyGetFirmwareInfoParams,
  ): Promise<FwUpdateProxyGetFirmwareInfoResult> {
    this.requireOnline();
    const res = await Module.request('fwGetInfo', {
      slave_id: params.slave_id,
      protocol: params.protocol || 'modbus',
    });
    if (res.error) throw new Error(res.error.message);
    return res.result as FwUpdateProxyGetFirmwareInfoResult;
  }

  async Update(params: FwUpdateProxyUpdateParams): Promise<void> {
    this.requireOnline();
    const res = await Module.request('fwUpdate', {
      slave_id: params.slave_id,
      type: params.type || 'firmware',
      protocol: params.protocol || 'modbus',
    });
    if (res.error) throw new Error(res.error.message);
  }

  async ClearError(params: FwUpdateProxyClearErrorParams): Promise<void> {
    const res = await Module.request('fwClearError', {
      slave_id: params.slave_id,
      type: params.type || 'firmware',
    });
    if (res.error) throw new Error(res.error.message);
  }

  async Restore(params: FwUpdateProxyRestoreParams): Promise<void> {
    this.requireOnline();
    const res = await Module.request('fwRestore', {
      slave_id: params.slave_id,
      protocol: params.protocol || 'modbus',
    });
    if (res.error) throw new Error(res.error.message);
  }
}

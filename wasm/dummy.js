function scanCallback(status)
{
    console.log('Port scan progress: ' + status.progress + '%' + (status.options ? ', options: ' + status.options : ''));
}

window.onload = function()
{
    document.querySelector('#portButton').addEventListener('click', async function()
    {
        await Module.serial.select(true);
    });

    document.querySelector('#scanButton').addEventListener('click', async function()
    {
        let data = await new PortScan(scanCallback).exec();

        if (!data.devices.length)
        {
            Module.print('no devices found');
            return;
        }

        Module.print(data.devices.length + ' devices found');
        Module.print(data);
    });

    document.querySelector('#typesButton').addEventListener('click', async function()
    {
        Module.print(await Module.request('configGetDeviceTypes', {lang: 'ru'}));
    });

    document.querySelector('#schemaButton').addEventListener('click', async function()
    {
        Module.print(await Module.request('configGetSchema', {type: 'WB-MSW v.3'}));
    });

    document.querySelector('#loadButton').addEventListener('click', async function()
    {
        let request = {
            baud_rate: 9600,
            data_bits: 8,
            parity: 'N',
            slave_id: 151,
            stop_bits: 2,
            device_type: 'WB-MAP6S fw2'
        }

        Module.print(await Module.request('deviceLoadConfig', request));
    });
}

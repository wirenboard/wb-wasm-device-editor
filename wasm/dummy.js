window.onload = function()
{
    document.querySelector('#portButton').addEventListener('click', async function()
    {
        await Module.serial.select(true);
    });

    document.querySelector('#scanButton').addEventListener('click', async function()
    {
        let data = await new PortScan().exec();

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
        Module.print(await Module.request('configGetSchema', {type: 'WB-LED'}));
    });
}

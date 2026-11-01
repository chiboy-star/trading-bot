const path = require('path');

async function testFetchBybitKlines() {
    const symbol = 'BTCUSDT';
    const startTs = new Date('2026-10-24T21:50:00.000Z').getTime();
    const endTs = startTs + 200 * 60 * 1000; // 200 minutes later

    const url = `https://api.bybit.com/v5/market/kline?category=linear&symbol=${symbol}&interval=1&start=${startTs}&end=${endTs}&limit=200`;
    console.log('Fetching:', url);

    const res = await fetch(url);
    const json = await res.json();
    console.log('RetCode:', json.retCode, 'RetMsg:', json.retMsg);
    if (json.result && json.result.list) {
        console.log('Returned bars count:', json.result.list.length);
        if (json.result.list.length > 0) {
            console.log('First bar:', json.result.list[json.result.list.length - 1]);
            console.log('Last bar:', json.result.list[0]);
        }
    }

    // Also test funding rates history
    const fUrl = `https://api.bybit.com/v5/market/funding/history?category=linear&symbol=${symbol}&startTime=${startTs}&endTime=${endTs}&limit=50`;
    const fRes = await fetch(fUrl);
    const fJson = await fRes.json();
    console.log('Funding RetCode:', fJson.retCode, 'count:', fJson.result?.list?.length);

    // Also test open interest history
    const oiUrl = `https://api.bybit.com/v5/market/open-interest?category=linear&symbol=${symbol}&intervalTime=5min&startTime=${startTs}&endTime=${endTs}&limit=50`;
    const oiRes = await fetch(oiUrl);
    const oiJson = await oiRes.json();
    console.log('OI RetCode:', oiJson.retCode, 'count:', oiJson.result?.list?.length);
}

testFetchBybitKlines().catch(console.error);

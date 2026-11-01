async function testPagination() {
    const symbol = 'BTCUSDT';
    const startTs = new Date('2026-10-24T21:50:00.000Z').getTime();
    const endTs = new Date('2026-10-25T20:25:00.000Z').getTime(); // 1356 minutes

    console.log(`Span from ${new Date(startTs).toISOString()} to ${new Date(endTs).toISOString()} (${Math.round((endTs-startTs)/60000)}m)`);

    // Fetch chunk 1
    const url1 = `https://api.bybit.com/v5/market/kline?category=linear&symbol=${symbol}&interval=1&start=${startTs}&end=${endTs}&limit=200`;
    const res1 = await (await fetch(url1)).json();
    const list1 = res1.result.list;
    console.log('List 1 length:', list1.length);
    console.log('List 1 newest:', new Date(Number(list1[0][0])).toISOString());
    console.log('List 1 oldest:', new Date(Number(list1[list1.length - 1][0])).toISOString());

    // Bybit returns bars where oldest is list1[list1.length - 1] and newest is list1[0]!
    // Notice that list1[0] is 2026-10-24T21:50 + 200m or is it endTs?
    // Let's check!
    
    // To paginate backwards from endTs:
    // fetch with end = oldest - 1ms
    const oldestTs = Number(list1[list1.length - 1][0]);
    const url2 = `https://api.bybit.com/v5/market/kline?category=linear&symbol=${symbol}&interval=1&start=${startTs}&end=${oldestTs - 1000}&limit=200`;
    const res2 = await (await fetch(url2)).json();
    const list2 = res2.result.list;
    console.log('List 2 length:', list2.length);
    if (list2.length > 0) {
        console.log('List 2 newest:', new Date(Number(list2[0][0])).toISOString());
        console.log('List 2 oldest:', new Date(Number(list2[list2.length - 1][0])).toISOString());
    }

    // OR to paginate forwards from startTs:
    // Notice: Bybit v5 kline returns bars within [start, end] sorted descending by default!
    // But does it return the 200 bars closest to start or closest to end?
    // In url1: list1[0][0] was 1792890600000 which is startTs + 200m!
    // That means it returned the first 200 bars after startTs!
    // So the next page forward should start at Number(list1[0][0]) + 60000!
    const newestTs = Number(list1[0][0]);
    const urlForward = `https://api.bybit.com/v5/market/kline?category=linear&symbol=${symbol}&interval=1&start=${newestTs + 60000}&end=${endTs}&limit=200`;
    const resF = await (await fetch(urlForward)).json();
    const listF = resF.result.list;
    console.log('Forward List length:', listF.length);
    console.log('Forward List newest:', new Date(Number(listF[0][0])).toISOString());
    console.log('Forward List oldest:', new Date(Number(listF[listF.length - 1][0])).toISOString());
}

testPagination().catch(console.error);

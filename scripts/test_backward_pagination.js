async function testBackwardPagination() {
    const symbol = 'BTCUSDT';
    const startTs = new Date('2026-10-24T21:50:00.000Z').getTime();
    const endTs = new Date('2026-10-25T20:25:00.000Z').getTime(); // 1355 minutes

    console.log(`Paginating BACKWARDS for ${symbol} from ${new Date(endTs).toISOString()} down to ${new Date(startTs).toISOString()}`);

    let currentEnd = endTs;
    let totalFetched = 0;
    let pages = 0;

    while (currentEnd >= startTs) {
        const url = `https://api.bybit.com/v5/market/kline?category=linear&symbol=${symbol}&interval=1&start=${startTs}&end=${currentEnd}&limit=200`;
        const res = await (await fetch(url)).json();
        const list = res.result?.list || [];
        if (list.length === 0) break;
        pages++;
        totalFetched += list.length;
        const newest = new Date(Number(list[0][0])).toISOString();
        const oldest = new Date(Number(list[list.length - 1][0])).toISOString();
        console.log(`Page ${pages}: ${list.length} bars (${newest} down to ${oldest})`);

        const oldestTs = Number(list[list.length - 1][0]);
        if (oldestTs <= startTs) {
            console.log('Reached startTs!');
            break;
        }
        currentEnd = oldestTs - 60000;
        await new Promise(r => setTimeout(r, 70));
    }

    console.log(`Total bars fetched: ${totalFetched} (expected span: ~${Math.round((endTs-startTs)/60000) + 1})`);
}

testBackwardPagination().catch(console.error);

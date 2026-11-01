const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.resolve(__dirname, '../data/recorder.db'), { readonly: true });

// Check EIDOUSDT, EQTUSDT, STMUSDT
console.log('=== CHECKING EIDOUSDT, EQTUSDT, STMUSDT ===');
const rows = db.prepare(`
    SELECT symbol, status, base_coin, quote_coin, launch_time, raw_json 
    FROM contract_snapshots 
    WHERE symbol IN ('EIDOUSDT', 'EQTUSDT', 'STMUSDT')
    GROUP BY symbol
`).all();
console.log(JSON.stringify(rows, null, 2));

// Also check if they exist at all or in listing_events
const listingRows = db.prepare(`
    SELECT * FROM listing_events WHERE symbol IN ('EIDOUSDT', 'EQTUSDT', 'STMUSDT')
`).all();
console.log('Listing events:', JSON.stringify(listingRows, null, 2));

db.close();

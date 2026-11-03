import dotenv from 'dotenv';
import path from 'path';

// Load .env from project root
dotenv.config({ path: path.resolve(process.cwd(), '.env') });

export const config = {
    app: {
        env: process.env.NODE_ENV || 'development',
        logLevel: process.env.LOG_LEVEL || 'info',
    },
    exchange: {
        bybitHostname: (process.env.BYBIT_HOSTNAME || 'bytick.com').replace(/^api\./, ''),
        takerFee: Number(process.env.TAKER_FEE || 0.00055), // 0.055% VIP0 taker fee
        makerFee: Number(process.env.MAKER_FEE || 0.00020), // 0.020% VIP0 maker fee
        coreSlippage: Number(process.env.CORE_SLIPPAGE || 0.0005), // 0.05% for BTC/ETH
        satelliteSlippage: Number(process.env.SATELLITE_SLIPPAGE || 0.0012), // 0.12% for altcoins
    },
    notifications: {
        discordWebhookUrl: process.env.DISCORD_WEBHOOK_URL || '',
    },
};

export type AppConfig = typeof config;
export default config;

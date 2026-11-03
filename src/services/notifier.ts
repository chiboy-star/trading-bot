import config from '../config';
import { createLogger } from '../utils/logger';

const log = createLogger('notifier');

export interface DiscordEmbedField {
    name: string;
    value: string;
    inline?: boolean;
}

export interface DiscordEmbed {
    title: string;
    description?: string;
    color: number;
    fields: DiscordEmbedField[];
    timestamp?: string;
    footer?: {
        text: string;
    };
}

/**
 * Dispatches a Discord embed payload via native fetch.
 * Returns false silently with a warning if DISCORD_WEBHOOK_URL is unset.
 */
export async function sendDiscordAlert(embed: DiscordEmbed): Promise<boolean> {
    const webhookUrl = config.notifications.discordWebhookUrl;
    if (!webhookUrl || webhookUrl.trim() === '') {
        log.warn('DISCORD_WEBHOOK_URL is not set. Discord alert skipped.');
        return false;
    }

    try {
        const payload = {
            username: "Bybit Market Data Recorder",
            avatar_url: "https://cryptologos.cc/logos/bitcoin-btc-logo.png",
            embeds: [embed]
        };

        const response = await fetch(webhookUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        if (!response.ok) {
            log.error({ status: response.status, statusText: response.statusText }, 'Failed to deliver Discord alert');
            return false;
        }

        return true;
    } catch (err: any) {
        log.error({ err: err?.message }, 'Error sending Discord webhook alert');
        return false;
    }
}

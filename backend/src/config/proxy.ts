import {HttpsProxyAgent} from 'https-proxy-agent';
import type {AxiosRequestConfig} from 'axios';
import {config} from './env';

/**
 * Outbound proxy plumbing for any request that hits YouTube.
 *
 * Render's egress IPs are datacenter ranges that YouTube rate-limits or
 * outright blocks ("Sign in to confirm you're not a bot"). In production we
 * route every YouTube HTTPS call through a proxy provider (Webshare /
 * PacketStream / etc.) configured via the `PROXY_URL` env var.
 *
 * The agent is built once and reused — re-instantiating `HttpsProxyAgent`
 * per request defeats keep-alive and adds ~50ms of TLS handshake per call.
 * `yt-dlp` subprocesses still receive the proxy via `--proxy`; this module
 * covers the axios-based code paths (timed-text, oEmbed, browse, player).
 */

let cachedAgent: HttpsProxyAgent<string> | undefined;
let cachedFor: string | undefined;

/**
 * Return the shared `HttpsProxyAgent`, or `undefined` when `PROXY_URL` isn't
 * set. Caches by URL so a runtime env change in tests doesn't return a stale
 * agent.
 */
export function getProxyAgent(): HttpsProxyAgent<string> | undefined {
	if (!config.PROXY_URL) return undefined;
	if (cachedAgent && cachedFor === config.PROXY_URL) return cachedAgent;
	cachedAgent = new HttpsProxyAgent(config.PROXY_URL);
	cachedFor = config.PROXY_URL;
	return cachedAgent;
}

/**
 * Spread into an axios request config to route the call through `PROXY_URL`.
 *
 * `proxy: false` is required: axios's built-in `proxy` option doesn't support
 * authenticated HTTPS proxies properly and conflicts with our agent — we
 * disable it and let `HttpsProxyAgent` handle the tunnel.
 *
 * Returns an empty object when no proxy is configured, so call sites stay
 * one-liner: `axios.get(url, { timeout: 8_000, ...proxyAxiosOptions() })`.
 */
export function proxyAxiosOptions(): Pick<
	AxiosRequestConfig,
	'proxy' | 'httpsAgent'
> {
	const agent = getProxyAgent();
	if (!agent) return {};
	return {proxy: false, httpsAgent: agent};
}

/** True when a real outbound proxy is configured. Useful for logging. */
export function isProxyConfigured(): boolean {
	return Boolean(config.PROXY_URL);
}

/**
 * Telegram alerter — minimal, dependency-free port of the sister project's
 * `solana-smart-money-bot/src/alerts/telegram-alert.ts`.
 *
 * Reuses the same bot token / chat ID that the sister project uses (see HANDOFF
 * "Watch-outs" — Telegram bot reuse). Messages are intended to be prefixed with
 * `[SignalForge]` by the caller to disambiguate from sister-project alerts in a
 * shared channel.
 *
 * Design choices:
 *   - HTML parse mode with disable_web_page_preview, plain-text fallback on HTTP
 *     error (mirrors sister-project pattern; HTML rendering fails on rare
 *     invalid escape sequences).
 *   - 1 msg/sec rate limit between sends — Telegram allows ~30/sec but we send
 *     low-volume status reports, so aggressive throttling protects us against
 *     accidental flood loops without being noticeable.
 *   - Native fetch only (Node 18+, project uses tsx + Node 22 per @types/node).
 *   - No external logger dependency: logs to console.error on failure, swallowing
 *     errors so a Telegram outage never breaks the daemon's primary contract
 *     (signal emission to live_signals).
 */
const TELEGRAM_API_BASE = 'https://api.telegram.org';
const RATE_LIMIT_MS = 1000;
// Hard timeout for each fetch — without this, a stalled connection hangs the
// daemon's terminal step indefinitely. 10s is generous; the Telegram API
// usually responds in <500ms for a single sendMessage.
const FETCH_TIMEOUT_MS = 10_000;

export class SignalForgeTelegram {
  private readonly token: string;
  private readonly chatId: string;
  private lastSentAt = 0;

  constructor(token?: string, chatId?: string) {
    this.token = token ?? process.env.TELEGRAM_BOT_TOKEN ?? '';
    this.chatId = chatId ?? process.env.TELEGRAM_ALERT_CHAT_ID ?? '';
  }

  /**
   * True iff both bot token and chat ID are configured. The daemon should call
   * this before composing a report — if false, skip the Telegram step entirely
   * (don't burn time formatting a message that can't be sent).
   */
  isConfigured(): boolean {
    return this.token.length > 10 && this.chatId.length > 0;
  }

  /**
   * Send a pre-formatted message. Returns true on success, false on configuration
   * miss / network error / HTTP error. Never throws — Telegram failure must not
   * abort the daemon.
   *
   * `text` is sent as-is with parse_mode='HTML'; callers that include user-supplied
   * strings should pass them through `escapeHtml()` first.
   */
  async send(text: string): Promise<boolean> {
    if (!this.isConfigured()) return false;

    const elapsed = Date.now() - this.lastSentAt;
    if (elapsed < RATE_LIMIT_MS) {
      await new Promise(resolve => setTimeout(resolve, RATE_LIMIT_MS - elapsed));
    }

    const url = `${TELEGRAM_API_BASE}/bot${this.token}/sendMessage`;
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: this.chatId,
          text,
          parse_mode: 'HTML',
          disable_web_page_preview: true,
        }),
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (res.ok) {
        this.lastSentAt = Date.now();
        return true;
      }
      // HTML parse_mode can fail on unbalanced tags or unsupported escapes.
      // Strip tags and retry as plain text — better to deliver the raw status
      // than swallow the report entirely.
      const errBody = await res.text().catch(() => '');
      console.error(`[Telegram] HTML send failed (${res.status}): ${errBody.slice(0, 200)}`);
      const plain = text.replace(/<[^>]+>/g, '');
      const retry = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: this.chatId,
          text: plain,
          disable_web_page_preview: true,
        }),
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (retry.ok) {
        this.lastSentAt = Date.now();
        return true;
      }
      const retryBody = await retry.text().catch(() => '');
      console.error(`[Telegram] plain-text retry failed (${retry.status}): ${retryBody.slice(0, 200)}`);
      return false;
    } catch (err) {
      console.error(`[Telegram] network error: ${(err as Error).message}`);
      return false;
    }
  }
}

/**
 * Escape HTML special characters for safe inclusion in HTML-mode Telegram
 * messages. Use on any caller-supplied string (ticker, error message, etc.)
 * before splicing into a template.
 */
export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

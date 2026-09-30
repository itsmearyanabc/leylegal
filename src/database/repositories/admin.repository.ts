import { Injectable } from '@nestjs/common';
import type { Sql, TransactionSql } from 'postgres';
import { DatabaseService } from '../database.service';

export interface TimeSeriesPoint {
  day: string;
  queries: number;
  users: number;
  flagged: number;
  avgLatencyMs: number;
}

export interface IntentSlice {
  intent: string;
  count: number;
  avgLatencyMs: number;
}

export interface AdminUserRow {
  id: string;
  phone_number: string | null;
  full_name: string | null;
  role: string;
  verification_status: string;
  preferred_language: string;
  /** Questions answered today, counted from search_history. */
  query_count: number;
  last_active_at: string;
  created_at: string;

  // --- Web account (migration 0010) ------------------------------------------
  email: string | null;
  email_verified: boolean;
  signup_source: string;
  phone_verified: boolean;
  free_credits: number;
  paid_credits: number;
}

export interface AdminSearchRow {
  id: string;
  phone_number: string;
  query_text: string;
  intent: string;
  citations: string[];
  result_count: number;
  model_used: string | null;
  latency_ms: number;
  guardrail_flagged: boolean;
  guardrail_reason: string | null;
  created_at: string;
}

export interface AdminMessageRow {
  id: string;
  phone_number: string;
  direction: string;
  message_type: string;
  body: string | null;
  status: string;
  error_detail: string | null;
  created_at: string;
}

/**
 * Read models for the admin panel.
 *
 * Kept apart from AnalyticsRepository because the concerns genuinely differ:
 * that one is on the hot path (every answered query writes through it), this one
 * runs a handful of times when a human opens a dashboard. Mixing them would put
 * expensive reporting aggregates next to code that has to stay fast.
 *
 * Every method here is read-only and bounded by an explicit LIMIT - an admin
 * page must never be able to pull the whole message log into memory.
 */
@Injectable()
export class AdminRepository {
  constructor(private readonly db: DatabaseService) {}

  /**
   * Daily activity for the dashboard chart.
   *
   * generate_series produces the full date range so days with no traffic appear
   * as zeroes. Without it the chart silently closes the gap and a dead weekend
   * looks like normal usage.
   */
  async timeSeries(days = 14): Promise<TimeSeriesPoint[]> {
    const rows = await this.db.sql<
      {
        day: string;
        queries: string;
        users: string;
        flagged: string;
        avg_latency: string | null;
      }[]
    >`
      SELECT to_char(d.day, 'YYYY-MM-DD')                       AS day,
             COUNT(s.id)                                        AS queries,
             COUNT(DISTINCT s.user_id)                          AS users,
             COUNT(*) FILTER (WHERE s.guardrail_flagged)        AS flagged,
             AVG(s.latency_ms)                                  AS avg_latency
        FROM generate_series(
               CURRENT_DATE - make_interval(days => ${days} - 1),
               CURRENT_DATE,
               '1 day'
             ) AS d(day)
        LEFT JOIN search_history s
               ON s.created_at >= d.day
              AND s.created_at <  d.day + INTERVAL '1 day'
       GROUP BY d.day
       ORDER BY d.day
    `;

    return rows.map((r) => ({
      day: r.day,
      queries: Number(r.queries),
      users: Number(r.users),
      flagged: Number(r.flagged),
      avgLatencyMs: r.avg_latency ? Math.round(Number(r.avg_latency)) : 0,
    }));
  }

  /** Intent mix, for the donut chart. */
  async intentBreakdown(days = 14): Promise<IntentSlice[]> {
    const rows = await this.db.sql<{ intent: string; count: string; avg_latency: string | null }[]>`
      SELECT intent::text        AS intent,
             COUNT(*)            AS count,
             AVG(latency_ms)     AS avg_latency
        FROM search_history
       WHERE created_at > NOW() - make_interval(days => ${days})
       GROUP BY intent
       ORDER BY COUNT(*) DESC
    `;
    return rows.map((r) => ({
      intent: r.intent,
      count: Number(r.count),
      avgLatencyMs: r.avg_latency ? Math.round(Number(r.avg_latency)) : 0,
    }));
  }

  /** Message volume and delivery outcomes, for the operations view. */
  async messageStats(days = 14): Promise<{ direction: string; status: string; count: number }[]> {
    const rows = await this.db.sql<{ direction: string; status: string; count: string }[]>`
      SELECT direction::text AS direction,
             status::text    AS status,
             COUNT(*)        AS count
        FROM whatsapp_messages
       WHERE created_at > NOW() - make_interval(days => ${days})
       GROUP BY direction, status
       ORDER BY COUNT(*) DESC
    `;
    return rows.map((r) => ({ direction: r.direction, status: r.status, count: Number(r.count) }));
  }

  /** User table, newest-active first. */
  /**
   * The users table.
   *
   * ## Why today's count no longer comes from `daily_usage`
   *
   * It used to `LEFT JOIN daily_usage`, which was correct until credits became
   * a ledger and nothing wrote to that table any more. The join kept working
   * and kept returning `COALESCE(..., 0)` - so the column silently read zero
   * for every user, on a page whose whole purpose is telling an operator who is
   * active. A wrong number that looks like a real one is worse than a missing
   * column, because nobody thinks to doubt it.
   *
   * `search_history` has a row per answered query already, so it is both the
   * honest source and one that cannot drift from what actually happened.
   *
   * Balances are read from the cached columns rather than through
   * `credit_balance()`, deliberately: this renders fifty rows, and the function
   * has the side effect of rolling the daily allowance over. Listing users
   * would otherwise write fifty ledger entries.
   */
  async listUsers(limit = 100, offset = 0, search?: string): Promise<AdminUserRow[]> {
    const pattern = search ? `%${search}%` : null;
    return this.db.sql<AdminUserRow[]>`
      SELECT u.id,
             u.phone_number,
             u.full_name,
             u.email,
             (u.email_verified_at IS NOT NULL) AS email_verified,
             (u.phone_verified_at IS NOT NULL) AS phone_verified,
             u.signup_source::text       AS signup_source,
             u.free_credits,
             u.paid_credits,
             u.role::text                AS role,
             u.verification_status::text AS verification_status,
             u.preferred_language,
             (SELECT COUNT(*) FROM search_history s
               WHERE s.user_id = u.id
                 AND s.created_at >= date_trunc('day', NOW()))::int AS query_count,
             u.last_active_at,
             u.created_at
        FROM users u
       WHERE ${pattern}::text IS NULL
          OR u.phone_number ILIKE ${pattern}
          OR u.full_name    ILIKE ${pattern}
          OR u.email        ILIKE ${pattern}
       ORDER BY u.last_active_at DESC
       LIMIT ${limit} OFFSET ${offset}
    `;
  }

  /**
   * Recent queries across all users, for the audit view.
   *
   * `flaggedOnly` is the hallucination review queue: everything the citation
   * validator had to intervene on.
   */
  async listSearches(limit = 100, offset = 0, flaggedOnly = false): Promise<AdminSearchRow[]> {
    return this.db.sql<AdminSearchRow[]>`
      SELECT s.id,
             u.phone_number,
             s.query_text,
             s.intent::text AS intent,
             s.citations,
             s.result_count,
             s.model_used,
             s.latency_ms,
             s.guardrail_flagged,
             s.guardrail_reason,
             s.created_at
        FROM search_history s
        JOIN users u ON u.id = s.user_id
       WHERE ${flaggedOnly} = FALSE OR s.guardrail_flagged
       ORDER BY s.created_at DESC
       LIMIT ${limit} OFFSET ${offset}
    `;
  }

  /** Raw message log, for debugging "why did the bot not reply". */
  async listMessages(limit = 100, offset = 0, phone?: string): Promise<AdminMessageRow[]> {
    const pattern = phone ? `%${phone}%` : null;
    return this.db.sql<AdminMessageRow[]>`
      SELECT id,
             phone_number,
             direction::text    AS direction,
             message_type,
             body,
             status::text       AS status,
             error_detail,
             created_at
        FROM whatsapp_messages
       WHERE ${pattern}::text IS NULL OR phone_number ILIKE ${pattern}
       ORDER BY created_at DESC
       LIMIT ${limit} OFFSET ${offset}
    `;
  }

  /** Settings change log for the audit tab. */
  async listSettingsAudit(limit = 50): Promise<
    { id: string; key: string; action: string; new_preview: string | null; changed_by: string; changed_at: string }[]
  > {
    return this.db.sql`
      SELECT id, key, action, new_preview, changed_by, changed_at
        FROM settings_audit
       ORDER BY changed_at DESC
       LIMIT ${limit}
    `;
  }

  /**
   * Corpus readiness, broken down by court.
   *
   * `embedded` vs `chunks` is the number that matters operationally: chunks
   * without an embedding are invisible to dense retrieval, so a large gap here
   * explains "the bot cannot find cases I know are loaded".
   */
  async corpusBreakdown(): Promise<{ court: string; judgments: number; chunks: number; embedded: number }[]> {
    const rows = await this.db.sql<
      { court: string; judgments: string; chunks: string; embedded: string }[]
    >`
      SELECT COALESCE(j.court_name, 'Unknown')                        AS court,
             COUNT(DISTINCT j.id)                                     AS judgments,
             COUNT(c.id)                                              AS chunks,
             COUNT(c.id) FILTER (WHERE c.embedding IS NOT NULL)       AS embedded
        FROM judgments j
        LEFT JOIN judgment_chunks c ON c.judgment_id = j.id
       GROUP BY j.court_name
       ORDER BY COUNT(DISTINCT j.id) DESC
       LIMIT 30
    `;
    return rows.map((r) => ({
      court: r.court,
      judgments: Number(r.judgments),
      chunks: Number(r.chunks),
      embedded: Number(r.embedded),
    }));
  }

  // ---------------------------------------------------------------------------
  // One account, in full
  // ---------------------------------------------------------------------------

  /**
   * Everything held about one account, for the admin detail view.
   *
   * Lists are capped at the most recent rows; `counts` says how many exist in
   * total, which is what the delete confirmation shows. `exportUser` is the
   * uncapped version.
   */
  async userDetail(userId: string): Promise<AdminUserDetail | null> {
    return this.collectUser(userId, 20);
  }

  /** Every row about one account, uncapped - taken before a deletion. */
  async exportUser(userId: string): Promise<AdminUserDetail | null> {
    return this.collectUser(userId, null);
  }

  private async collectUser(userId: string, limit: number | null): Promise<AdminUserDetail | null> {
    const [user] = await this.db.sql<Record<string, unknown>[]>`SELECT * FROM users WHERE id = ${userId}`;
    if (!user) return null;

    const phone = (user.phone_number as string | null) ?? null;
    // postgres.js has no "no limit" value; ALL is spelled as a very large number.
    const cap = limit ?? 1_000_000;
    const sql = this.db.sql;

    const [
      counts,
      identities,
      sessions,
      ledger,
      orders,
      threads,
      chatMessages,
      whatsappMessages,
      searches,
      state,
      memory,
    ] = await Promise.all([
      countUserRows(sql, userId, phone),
      sql`SELECT provider, email, display_name, last_login_at, created_at
            FROM user_identities WHERE user_id = ${userId} ORDER BY created_at`,
      // Never the token hash: it is a credential, and the panel has no use for it.
      sql`SELECT id, user_agent, host(ip_address) AS ip_address, created_at, last_used_at, expires_at, revoked_at
            FROM web_sessions WHERE user_id = ${userId} ORDER BY created_at DESC LIMIT ${cap}`,
      sql`SELECT kind::text AS kind, bucket::text AS bucket, delta, balance_after, action, reason, created_at
            FROM credit_ledger WHERE user_id = ${userId} ORDER BY created_at DESC LIMIT ${cap}`,
      sql`SELECT receipt, credits, amount_paise, status::text AS status, razorpay_payment_id, created_at
            FROM credit_orders WHERE user_id = ${userId} ORDER BY created_at DESC LIMIT ${cap}`,
      sql`SELECT id, title, message_count, last_message_at, created_at
            FROM chat_threads WHERE user_id = ${userId} ORDER BY last_message_at DESC LIMIT ${cap}`,
      limit === null
        ? sql`SELECT thread_id, role, content, intent::text AS intent, citations, credits_charged, created_at
                FROM chat_messages WHERE user_id = ${userId} ORDER BY created_at`
        : Promise.resolve([]),
      sql`SELECT direction::text AS direction, message_type, body, status::text AS status, error_detail, created_at
            FROM whatsapp_messages
           WHERE user_id = ${userId} OR (${phone}::text IS NOT NULL AND phone_number = ${phone})
           ORDER BY created_at DESC LIMIT ${cap}`,
      sql`SELECT query_text, intent::text AS intent, citations, result_count, model_used,
                 latency_ms, guardrail_flagged, created_at
            FROM search_history WHERE user_id = ${userId} ORDER BY created_at DESC LIMIT ${cap}`,
      sql`SELECT state, expires_at, updated_at FROM conversation_states WHERE user_id = ${userId}`,
      sql`SELECT jsonb_array_length(turns) AS turns, expires_at FROM whatsapp_memory WHERE user_id = ${userId}`,
    ]);

    return {
      user,
      counts,
      identities,
      sessions,
      ledger,
      orders,
      threads,
      chatMessages,
      whatsappMessages,
      searches,
      conversationState: state[0] ?? null,
      whatsappMemory: memory[0] ?? null,
    } as AdminUserDetail;
  }

  /**
   * Delete an account and everything that belongs to it, in one transaction.
   *
   * Most of it goes by cascade: every table that holds a `user_id` references
   * `users` with ON DELETE CASCADE. Four things do not, and are removed first:
   *
   *  - WhatsApp messages logged before the account existed carry the phone
   *    number and no user id, so the cascade cannot see them.
   *  - The webhook idempotency keys for those messages.
   *  - Queued jobs, which are keyed by the sender's number.
   *  - Payment events, which point at an order and would otherwise survive it
   *    with the order id nulled and the payer's details still in the payload.
   *
   * Returns what was removed, counted inside the same transaction, or null if
   * the account does not exist. After this the email address and the WhatsApp
   * number are free: a new sign-up or a new message starts a new account.
   */
  async deleteUserCompletely(userId: string): Promise<UserDeletionReport | null> {
    return this.db.sql.begin(async (sql) => {
      const [user] = await sql<{ phone_number: string | null; email: string | null }[]>`
        SELECT phone_number, email FROM users WHERE id = ${userId} FOR UPDATE
      `;
      if (!user) return null;

      const phone = user.phone_number;
      const removed = await countUserRows(sql, userId, phone);

      await sql`
        DELETE FROM processed_webhooks p
         USING whatsapp_messages m
         WHERE (m.user_id = ${userId} OR (${phone}::text IS NOT NULL AND m.phone_number = ${phone}))
           AND m.wa_message_id IS NOT NULL
           AND (p.event_key = 'wa:' || m.wa_message_id
                OR p.event_key = 'wa:answered:' || m.wa_message_id
                OR starts_with(p.event_key, 'status:' || m.wa_message_id || ':'))
      `;
      if (phone) {
        await sql`DELETE FROM job_queue WHERE lock_key = ${phone}`;
        await sql`DELETE FROM whatsapp_messages WHERE phone_number = ${phone}`;
      }
      await sql`
        DELETE FROM payment_events
         WHERE order_id IN (SELECT id FROM credit_orders WHERE user_id = ${userId})
      `;
      await sql`DELETE FROM users WHERE id = ${userId}`;

      return { phone: user.phone_number, email: user.email, removed };
    });
  }

  /** Record who deleted which account, without keeping the account's details. */
  async auditUserDeletion(userId: string, summary: string, deletedBy: string): Promise<void> {
    await this.db.sql`
      INSERT INTO settings_audit (key, action, new_preview, changed_by)
      VALUES (${'user:' + userId}, 'DELETE_USER', ${summary.slice(0, 500)}, ${deletedBy.slice(0, 120)})
    `;
  }
}

export interface AdminUserDetail {
  user: Record<string, unknown>;
  counts: UserRowCounts;
  identities: Record<string, unknown>[];
  sessions: Record<string, unknown>[];
  ledger: Record<string, unknown>[];
  orders: Record<string, unknown>[];
  threads: Record<string, unknown>[];
  /** Filled only in the export; the detail view shows thread titles instead. */
  chatMessages: Record<string, unknown>[];
  whatsappMessages: Record<string, unknown>[];
  searches: Record<string, unknown>[];
  conversationState: Record<string, unknown> | null;
  whatsappMemory: Record<string, unknown> | null;
}

export interface UserRowCounts {
  chat_threads: number;
  chat_messages: number;
  whatsapp_messages: number;
  search_history: number;
  credit_ledger: number;
  credit_orders: number;
  web_sessions: number;
  user_identities: number;
  auth_tokens: number;
  queued_jobs: number;
}

export interface UserDeletionReport {
  phone: string | null;
  email: string | null;
  removed: UserRowCounts;
}

/** How many rows each table holds for one account. Shared by detail and delete. */
async function countUserRows(sql: Sql | TransactionSql, userId: string, phone: string | null): Promise<UserRowCounts> {
  const [row] = await sql<UserRowCounts[]>`
    SELECT
      (SELECT COUNT(*) FROM chat_threads     WHERE user_id = ${userId})::int AS chat_threads,
      (SELECT COUNT(*) FROM chat_messages    WHERE user_id = ${userId})::int AS chat_messages,
      (SELECT COUNT(*) FROM whatsapp_messages
        WHERE user_id = ${userId} OR (${phone}::text IS NOT NULL AND phone_number = ${phone}))::int AS whatsapp_messages,
      (SELECT COUNT(*) FROM search_history   WHERE user_id = ${userId})::int AS search_history,
      (SELECT COUNT(*) FROM credit_ledger    WHERE user_id = ${userId})::int AS credit_ledger,
      (SELECT COUNT(*) FROM credit_orders    WHERE user_id = ${userId})::int AS credit_orders,
      (SELECT COUNT(*) FROM web_sessions     WHERE user_id = ${userId})::int AS web_sessions,
      (SELECT COUNT(*) FROM user_identities  WHERE user_id = ${userId})::int AS user_identities,
      (SELECT COUNT(*) FROM auth_tokens      WHERE user_id = ${userId})::int AS auth_tokens,
      (SELECT COUNT(*) FROM job_queue
        WHERE ${phone}::text IS NOT NULL AND lock_key = ${phone})::int AS queued_jobs
  `;
  return row;
}

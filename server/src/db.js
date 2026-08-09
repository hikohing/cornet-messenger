import pg from 'pg'

const { Pool } = pg

const connectionString = process.env.DATABASE_URL
if (!connectionString) {
  throw new Error('DATABASE_URL не задан. Требуется подключение к Postgres.')
}

const isLocalConnection = /:\/\/[^@]*@?(localhost|127\.0\.0\.1|::1)([:/]|$)/.test(connectionString)

export const pool = new Pool({
  connectionString,
  ssl: isLocalConnection || connectionString.includes('railway.internal') ? false : { rejectUnauthorized: false },
})

export async function one(sql, params = []) {
  const { rows } = await pool.query(sql, params)
  return rows[0] ?? null
}

export async function many(sql, params = []) {
  const { rows } = await pool.query(sql, params)
  return rows
}

export async function run(sql, params = []) {
  return pool.query(sql, params)
}

/**
 * Выполняет несколько запросов одной транзакцией. Нужно там, где половина
 * работы хуже, чем ничего — например при удалении аккаунта: пользователь без
 * своих чатов или чаты без пользователя одинаково плохи.
 *
 * Колбэк получает клиента; все запросы внутри обязаны идти через него, иначе
 * они уедут в другое соединение и окажутся вне транзакции.
 */
export async function withTransaction(handler) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const result = await handler(client)
    await client.query('COMMIT')
    return result
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined)
    throw err
  } finally {
    client.release()
  }
}

export async function initSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      color TEXT NOT NULL,
      avatar_url TEXT,
      banner_url TEXT,
      banner_style TEXT NOT NULL DEFAULT 'profile',
      avatar_decoration TEXT NOT NULL DEFAULT 'none',
      profile_effect TEXT NOT NULL DEFAULT 'none',
      profile_theme TEXT NOT NULL DEFAULT 'default',
      name_style TEXT NOT NULL DEFAULT 'plain',
      profile_frame TEXT NOT NULL DEFAULT 'none',
      nameplate_style TEXT NOT NULL DEFAULT 'none',
      profile_primary_color TEXT,
      profile_secondary_color TEXT,
      show_last_seen BOOLEAN NOT NULL DEFAULT true,
      bio TEXT NOT NULL DEFAULT '',
      birth_date TEXT,
      display_name TEXT,
      last_seen_at BIGINT,
      created_at BIGINT NOT NULL
    );

    ALTER TABLE users ADD COLUMN IF NOT EXISTS bio TEXT NOT NULL DEFAULT '';
    ALTER TABLE users ADD COLUMN IF NOT EXISTS birth_date TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS display_name TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS banner_url TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS banner_style TEXT NOT NULL DEFAULT 'profile';
    ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_decoration TEXT NOT NULL DEFAULT 'none';
    ALTER TABLE users ADD COLUMN IF NOT EXISTS profile_effect TEXT NOT NULL DEFAULT 'none';
    ALTER TABLE users ADD COLUMN IF NOT EXISTS profile_theme TEXT NOT NULL DEFAULT 'default';
    ALTER TABLE users ADD COLUMN IF NOT EXISTS name_style TEXT NOT NULL DEFAULT 'plain';
    ALTER TABLE users ADD COLUMN IF NOT EXISTS profile_frame TEXT NOT NULL DEFAULT 'none';
    ALTER TABLE users ADD COLUMN IF NOT EXISTS nameplate_style TEXT NOT NULL DEFAULT 'none';
    ALTER TABLE users ADD COLUMN IF NOT EXISTS profile_primary_color TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS profile_secondary_color TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS email TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified BOOLEAN NOT NULL DEFAULT false;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users (LOWER(email)) WHERE email IS NOT NULL;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS status_text TEXT NOT NULL DEFAULT '';
    ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_secret TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_enabled BOOLEAN NOT NULL DEFAULT false;

    CREATE TABLE IF NOT EXISTS email_verifications (
      token_hash TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      email TEXT NOT NULL,
      created_at BIGINT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS password_resets (
      token_hash TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at BIGINT NOT NULL,
      used BOOLEAN NOT NULL DEFAULT false
    );

    CREATE TABLE IF NOT EXISTS blocked_users (
      blocker_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      blocked_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at BIGINT NOT NULL,
      PRIMARY KEY (blocker_id, blocked_id)
    );

    CREATE INDEX IF NOT EXISTS idx_blocked_users_blocked ON blocked_users(blocked_id);

    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at BIGINT NOT NULL
    );

    ALTER TABLE sessions ADD COLUMN IF NOT EXISTS user_agent TEXT;
    ALTER TABLE sessions ADD COLUMN IF NOT EXISTS last_seen_at BIGINT;

    CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_created ON sessions(created_at);

    CREATE TABLE IF NOT EXISTS totp_backup_codes (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      code_hash TEXT NOT NULL,
      used BOOLEAN NOT NULL DEFAULT false,
      created_at BIGINT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_totp_backup_codes_user ON totp_backup_codes(user_id);

    CREATE TABLE IF NOT EXISTS pending_logins (
      token_hash TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at BIGINT NOT NULL
    );

    -- Устройства для пуш-уведомлений. Одна строка — одна установка приложения
    -- (или один браузер), привязанная к сессии: разлогин и отзыв сессии должны
    -- забирать с собой и право слать на это устройство пуши.
    CREATE TABLE IF NOT EXISTS push_devices (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      -- Хэш session token, как в sessions.token. NULL — сессия уже удалена, но
      -- устройство ещё не отписалось.
      session_token TEXT,
      -- 'apns' для нативного iOS, 'webpush' для браузера и PWA.
      provider TEXT NOT NULL,
      -- APNs device token либо endpoint подписки Web Push.
      device_token TEXT NOT NULL,
      -- p256dh/auth подписки Web Push; для APNs не используется.
      keys JSONB,
      preview BOOLEAN NOT NULL DEFAULT true,
      direct_enabled BOOLEAN NOT NULL DEFAULT true,
      group_enabled BOOLEAN NOT NULL DEFAULT true,
      created_at BIGINT NOT NULL,
      last_used_at BIGINT
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_push_devices_token ON push_devices(provider, device_token);
    CREATE INDEX IF NOT EXISTS idx_push_devices_user ON push_devices(user_id);
    CREATE INDEX IF NOT EXISTS idx_push_devices_session ON push_devices(session_token);

    CREATE TABLE IF NOT EXISTS chats (
      id SERIAL PRIMARY KEY,
      type TEXT NOT NULL DEFAULT 'direct',
      name TEXT,
      description TEXT NOT NULL DEFAULT '',
      avatar_url TEXT,
      pinned_message_id INTEGER,
      created_at BIGINT NOT NULL
    );

    ALTER TABLE chats ADD COLUMN IF NOT EXISTS description TEXT NOT NULL DEFAULT '';
    ALTER TABLE chats ADD COLUMN IF NOT EXISTS avatar_url TEXT;
    -- 0 = таймер выключен; иначе через сколько секунд после отправки сообщение удаляется.
    ALTER TABLE chats ADD COLUMN IF NOT EXISTS auto_delete_seconds INTEGER NOT NULL DEFAULT 0;

    CREATE TABLE IF NOT EXISTS chat_members (
      chat_id INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      last_read_message_id INTEGER NOT NULL DEFAULT 0,
      pinned BOOLEAN NOT NULL DEFAULT false,
      PRIMARY KEY (chat_id, user_id)
    );

    ALTER TABLE chat_members ADD COLUMN IF NOT EXISTS pinned BOOLEAN NOT NULL DEFAULT false;
    ALTER TABLE chat_members ADD COLUMN IF NOT EXISTS archived BOOLEAN NOT NULL DEFAULT false;
    -- NULL = звук включён; иначе до какого момента чат беззвучный.
    -- Отдельное значение для «навсегда» не нужно: кладём дату далеко в будущем.
    ALTER TABLE chat_members ADD COLUMN IF NOT EXISTS muted_until BIGINT;

    CREATE TABLE IF NOT EXISTS chat_folders (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      position INTEGER NOT NULL DEFAULT 0,
      created_at BIGINT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS chat_folder_items (
      folder_id INTEGER NOT NULL REFERENCES chat_folders(id) ON DELETE CASCADE,
      chat_id INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
      PRIMARY KEY (folder_id, chat_id)
    );

    CREATE INDEX IF NOT EXISTS idx_chat_folders_user ON chat_folders(user_id);

    CREATE TABLE IF NOT EXISTS messages (
      id SERIAL PRIMARY KEY,
      chat_id INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
      sender_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      type TEXT NOT NULL DEFAULT 'text',
      text TEXT NOT NULL DEFAULT '',
      attachment_url TEXT,
      reply_to_id INTEGER,
      forwarded BOOLEAN NOT NULL DEFAULT false,
      edited_at BIGINT,
      deleted BOOLEAN NOT NULL DEFAULT false,
      call_meta JSONB,
      attachment_meta JSONB,
      created_at BIGINT NOT NULL
    );

    ALTER TABLE messages ADD COLUMN IF NOT EXISTS call_meta JSONB;
    ALTER TABLE messages ADD COLUMN IF NOT EXISTS attachment_meta JSONB;
    ALTER TABLE messages ADD COLUMN IF NOT EXISTS encrypted BOOLEAN NOT NULL DEFAULT false;
    ALTER TABLE messages ADD COLUMN IF NOT EXISTS encryption_data JSONB;

    CREATE TABLE IF NOT EXISTS public_keys (
      user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      x25519_public_key JSONB NOT NULL,
      ed25519_public_key JSONB NOT NULL,
      public_key_signature TEXT NOT NULL,
      created_at BIGINT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS group_encryption_keys (
      chat_id INTEGER PRIMARY KEY REFERENCES chats(id) ON DELETE CASCADE,
      rotation_number INTEGER NOT NULL DEFAULT 1,
      created_at BIGINT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS group_key_shares (
      chat_id INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      rotation_number INTEGER NOT NULL,
      wrapped_key TEXT NOT NULL,
      iv TEXT NOT NULL,
      ephemeral_public_key JSONB NOT NULL,
      created_at BIGINT NOT NULL,
      PRIMARY KEY (chat_id, user_id, rotation_number)
    );

    CREATE TABLE IF NOT EXISTS polls (
      message_id INTEGER PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
      chat_id INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
      question TEXT NOT NULL,
      anonymous BOOLEAN NOT NULL DEFAULT true,
      multiple_choice BOOLEAN NOT NULL DEFAULT false,
      closed BOOLEAN NOT NULL DEFAULT false,
      created_at BIGINT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS poll_options (
      id SERIAL PRIMARY KEY,
      message_id INTEGER NOT NULL REFERENCES polls(message_id) ON DELETE CASCADE,
      position INTEGER NOT NULL,
      text TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS poll_votes (
      message_id INTEGER NOT NULL REFERENCES polls(message_id) ON DELETE CASCADE,
      option_id INTEGER NOT NULL REFERENCES poll_options(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at BIGINT NOT NULL,
      PRIMARY KEY (message_id, option_id, user_id)
    );

    CREATE INDEX IF NOT EXISTS idx_poll_options_message ON poll_options(message_id);
    CREATE INDEX IF NOT EXISTS idx_poll_votes_message ON poll_votes(message_id);

    CREATE TABLE IF NOT EXISTS reactions (
      message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      emoji TEXT NOT NULL,
      PRIMARY KEY (message_id, user_id, emoji)
    );

    -- Жалобы на контент и на пользователей. Требование App Store к приложениям
    -- с пользовательским контентом (Guideline 1.2): должен быть способ
    -- пожаловаться и получить ответ. Объявлено после messages и chats —
    -- внешние ключи ссылаются на них.
    CREATE TABLE IF NOT EXISTS reports (
      id SERIAL PRIMARY KEY,
      -- Автор жалобы. При удалении аккаунта жалоба остаётся, но обезличивается:
      -- модерации важно само нарушение, а не кто на него указал.
      reporter_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      target_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      -- Сообщение или чат могут исчезнуть раньше, чем жалобу рассмотрят.
      message_id INTEGER REFERENCES messages(id) ON DELETE SET NULL,
      chat_id INTEGER REFERENCES chats(id) ON DELETE SET NULL,
      reason TEXT NOT NULL,
      comment TEXT NOT NULL DEFAULT '',
      -- Копия текста, снятая на устройстве жалующегося: в зашифрованных чатах
      -- сервер видит только шифротекст, и рассматривать жалобу было бы не по чему.
      excerpt TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'open',
      created_at BIGINT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_reports_status ON reports(status, created_at);
    CREATE INDEX IF NOT EXISTS idx_reports_target ON reports(target_user_id);

    CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages(chat_id);
    CREATE INDEX IF NOT EXISTS idx_chat_members_user ON chat_members(user_id);
    -- Сборщик просроченных сообщений ходит по (chat_id, created_at), поэтому
    -- индекс составной: иначе на большой истории это был бы полный скан.
    CREATE INDEX IF NOT EXISTS idx_messages_chat_created ON messages(chat_id, created_at);
  `)
}

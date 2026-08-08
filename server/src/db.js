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

    CREATE TABLE IF NOT EXISTS chat_members (
      chat_id INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      last_read_message_id INTEGER NOT NULL DEFAULT 0,
      pinned BOOLEAN NOT NULL DEFAULT false,
      PRIMARY KEY (chat_id, user_id)
    );

    ALTER TABLE chat_members ADD COLUMN IF NOT EXISTS pinned BOOLEAN NOT NULL DEFAULT false;

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

    CREATE TABLE IF NOT EXISTS reactions (
      message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      emoji TEXT NOT NULL,
      PRIMARY KEY (message_id, user_id, emoji)
    );

    CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages(chat_id);
    CREATE INDEX IF NOT EXISTS idx_chat_members_user ON chat_members(user_id);
  `)
}

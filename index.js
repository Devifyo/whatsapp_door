import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  makeCacheableSignalKeyStore,
  fetchLatestBaileysVersion,
  isJidBroadcast,
  downloadMediaMessage,
} from '@whiskeysockets/baileys'
import pino from 'pino'
import express from 'express'
import Database from 'better-sqlite3'
import QRCode from 'qrcode'
import { createServer } from 'http'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { mkdirSync, writeFileSync, rmSync } from 'fs'
import crypto from 'crypto'

const __dirname = dirname(fileURLToPath(import.meta.url))
const logger    = pino({ level: 'silent' })

const MEDIA_DIR = '/data/media'
mkdirSync(MEDIA_DIR, { recursive: true })

// ─── Database ─────────────────────────────────────────────────────────────────
const db = new Database('/data/messages.db')
db.pragma('journal_mode = WAL')

db.exec(`
  CREATE TABLE IF NOT EXISTS messages (
    id             TEXT PRIMARY KEY,
    jid            TEXT NOT NULL,
    from_jid       TEXT,
    sender_name    TEXT,
    content        TEXT,
    msg_type       TEXT,
    timestamp      INTEGER,
    is_from_me     INTEGER DEFAULT 0,
    is_deleted     INTEGER DEFAULT 0,
    deleted_at     INTEGER,
    media_url      TEXT,
    receipt_status TEXT DEFAULT 'sent',
    read_at        INTEGER,
    raw_data       TEXT
  );
  CREATE TABLE IF NOT EXISTS chats (
    jid          TEXT PRIMARY KEY,
    name         TEXT,
    last_msg     TEXT,
    last_msg_at  INTEGER,
    unread_count INTEGER DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_messages_jid ON messages(jid);
  CREATE INDEX IF NOT EXISTS idx_messages_ts  ON messages(timestamp);
`)

// Migrate existing DBs
for (const sql of [
  `ALTER TABLE messages ADD COLUMN receipt_status TEXT DEFAULT 'sent'`,
  `ALTER TABLE messages ADD COLUMN read_at INTEGER`,
  `ALTER TABLE chats ADD COLUMN phone TEXT`,
]) { try { db.exec(sql) } catch (_) {} }

// Default settings (INSERT OR IGNORE = don't overwrite user changes)
const SETTING_DEFAULTS = {
  hide_read_receipts:   'true',   // no blue ticks
  hide_delivery_ticks:  'false',  // hide grey ✓✓ in UI only
  anti_delete:          'true',   // preserve deleted messages
  hide_online:          'true',   // appear offline
  hide_typing:          'true',   // don't show typing/recording
  new_msg_alerts:       'false',  // browser alerts (frontend only)
}
const _insertDef = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)')
for (const [k, v] of Object.entries(SETTING_DEFAULTS)) _insertDef.run(k, v)

function getSetting(key) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key)
  return (row ? row.value : SETTING_DEFAULTS[key]) === 'true'
}

// ─── Prepared statements ──────────────────────────────────────────────────────
const stmt = {
  insertMsg: db.prepare(`
    INSERT OR REPLACE INTO messages
      (id, jid, from_jid, sender_name, content, msg_type, timestamp,
       is_from_me, receipt_status, raw_data)
    VALUES
      (@id, @jid, @from_jid, @sender_name, @content, @msg_type, @timestamp,
       @is_from_me, @receipt_status, @raw_data)
  `),
  markDeleted: db.prepare(
    `UPDATE messages SET is_deleted = 1, deleted_at = @deleted_at WHERE id = @id`
  ),
  updateMedia: db.prepare(
    `UPDATE messages SET media_url = @media_url WHERE id = @id`
  ),
  updateReceipt: db.prepare(
    `UPDATE messages SET receipt_status = @status, read_at = @read_at
     WHERE id = @id AND is_from_me = 1`
  ),
  getMessages:   db.prepare(`SELECT * FROM messages WHERE jid = ? ORDER BY timestamp DESC LIMIT 200`),
  getChats:      db.prepare(`SELECT * FROM chats ORDER BY last_msg_at DESC`),
  upsertChat:    db.prepare(`
    INSERT INTO chats (jid, name, phone, last_msg, last_msg_at)
      VALUES (@jid, @name, @phone, @last_msg, @last_msg_at)
    ON CONFLICT(jid) DO UPDATE SET
      name        = COALESCE(@name, name),
      phone       = COALESCE(@phone, phone),
      last_msg    = @last_msg,
      last_msg_at = @last_msg_at
  `),
  updateChatPhone: db.prepare(
    `UPDATE chats SET phone = @phone WHERE jid = @jid AND phone IS NULL`
  ),
  getDeletedMsgs: db.prepare(`SELECT * FROM messages WHERE is_deleted = 1 ORDER BY deleted_at DESC LIMIT 100`),
  searchMsgs:    db.prepare(`SELECT * FROM messages WHERE content LIKE ? ORDER BY timestamp DESC LIMIT 100`),
  getAllSettings: db.prepare(`SELECT key, value FROM settings`),
  setSetting:    db.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)`),
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function getJidName(jid) { return jid?.split('@')[0] || jid }
function phoneFromJid(jid) {
  return jid?.endsWith('@s.whatsapp.net') ? jid.split('@')[0].split(':')[0] : null
}

// Map Baileys msg.status → receipt_status string
// 0=ERROR 1=PENDING 2=SERVER_ACK 3=DELIVERY_ACK 4=READ 5=PLAYED
function statusToReceipt(s) {
  if (s === 4 || s === 5) return 'read'
  if (s === 3)            return 'delivered'
  return 'sent'
}

function mimeToExt(mime = '') {
  if (mime.includes('jpeg') || mime.includes('jpg')) return '.jpg'
  if (mime.includes('png'))        return '.png'
  if (mime.includes('webp'))       return '.webp'
  if (mime.includes('gif'))        return '.gif'
  if (mime.includes('mp4'))        return '.mp4'
  if (mime.includes('quicktime'))  return '.mov'
  if (mime.includes('webm'))       return '.webm'
  if (mime.includes('ogg'))        return '.ogg'
  if (mime.includes('mp3') || mime.includes('mpeg')) return '.mp3'
  if (mime.includes('m4a') || mime.includes('mp4a')) return '.m4a'
  return '.bin'
}

function unwrap(m) {
  return m.ephemeralMessage?.message
    || m.viewOnceMessage?.message
    || m.viewOnceMessageV2?.message?.viewOnceMessage?.message
    || m.documentWithCaptionMessage?.message
    || m
}

function extractContent(msg) {
  const m = msg.message
  if (!m) return ''
  if (m.protocolMessage)              return null
  if (m.senderKeyDistributionMessage) return null
  if (m.messageContextInfo && Object.keys(m).length === 1) return null

  const inner = unwrap(m)
  if (inner.conversation)                return inner.conversation
  if (inner.extendedTextMessage?.text)   return inner.extendedTextMessage.text
  if (inner.imageMessage)                return inner.imageMessage.caption ? `📷 ${inner.imageMessage.caption}` : '📷 Photo'
  if (inner.videoMessage)                return inner.videoMessage.caption ? `🎥 ${inner.videoMessage.caption}` : '🎥 Video'
  if (inner.audioMessage)                return inner.audioMessage.ptt ? '🎤 Voice message' : '🎵 Audio'
  if (inner.documentMessage)             return `📄 ${inner.documentMessage.fileName || 'Document'}`
  if (inner.stickerMessage)              return '🎭 Sticker'
  if (inner.reactionMessage)             return `${inner.reactionMessage.text || '❤️'} (reaction)`
  if (inner.locationMessage)             return `📍 Location`
  if (inner.liveLocationMessage)         return `📍 Live Location`
  if (inner.contactMessage)              return `👤 Contact: ${inner.contactMessage.displayName}`
  if (inner.contactsArrayMessage)        return `👥 Contacts (${inner.contactsArrayMessage.contacts?.length || '?'})`
  if (inner.pollCreationMessage)         return `📊 Poll: ${inner.pollCreationMessage.name}`
  if (inner.pollCreationMessageV3)       return `📊 Poll: ${inner.pollCreationMessageV3.name}`
  if (inner.buttonsMessage?.contentText) return inner.buttonsMessage.contentText
  if (inner.listMessage?.description)    return inner.listMessage.description
  if (inner.templateMessage?.hydratedTemplate?.hydratedContentText)
    return inner.templateMessage.hydratedTemplate.hydratedContentText
  if (inner.interactiveMessage?.body?.text) return inner.interactiveMessage.body.text
  if (inner.groupInviteMessage)          return `👥 Group invite: ${inner.groupInviteMessage.groupName}`
  if (inner.callLogMessage)              return inner.callLogMessage.isVideo ? '📹 Video call' : '📞 Voice call'
  if (inner.orderMessage)                return '🛍️ Order'
  if (inner.productMessage)              return `🛍️ Product: ${inner.productMessage.product?.title || ''}`

  const keys = Object.keys(m).filter(k =>
    k !== 'messageContextInfo' && k !== 'senderKeyDistributionMessage'
  )
  return keys.length ? `[${keys[0].replace('Message', '')}]` : ''
}

function getMediaNode(msg) {
  const m = msg.message
  if (!m) return null
  const inner = unwrap(m)
  if (inner.imageMessage)    return { node: inner.imageMessage,    type: 'image' }
  if (inner.videoMessage)    return { node: inner.videoMessage,    type: 'video' }
  if (inner.audioMessage)    return { node: inner.audioMessage,    type: 'audio' }
  if (inner.documentMessage) return { node: inner.documentMessage, type: 'document' }
  if (inner.stickerMessage)  return { node: inner.stickerMessage,  type: 'sticker' }
  return null
}

async function downloadAndSaveMedia(msg, sock) {
  const media = getMediaNode(msg)
  if (!media) return null
  const ext      = mimeToExt(media.node.mimetype || '')
  const filename = `${msg.key.id}${ext}`
  const filepath = join(MEDIA_DIR, filename)
  const buffer   = await downloadMediaMessage(msg, 'buffer', {}, {
    logger,
    reuploadRequest: sock.updateMediaMessage,
  })
  writeFileSync(filepath, buffer)
  return `/media/${filename}`
}

// ─── Express ──────────────────────────────────────────────────────────────────
const app = express()
app.use(express.json())
app.use(express.static(join(__dirname, 'public')))
app.use('/media', express.static(MEDIA_DIR))

let currentQR               = null
let isConnected             = false
let currentSock             = null
let isLoggingOut            = false
let qrAutoSessionAvailable  = false  // one-time flag: true only immediately after a QR scan

// ─── Session helpers ──────────────────────────────────────────────────────────
// activeSessions: token → { expiry, type: 'user' | 'admin' }
const activeSessions = new Map()
const SESSION_TTL    = 7 * 24 * 60 * 60 * 1000  // 7 days

function generateSessionToken() {
  return crypto.randomBytes(32).toString('hex')
}

function cleanExpiredSessions() {
  const now = Date.now()
  for (const [token, sess] of activeSessions) {
    if (now > sess.expiry) activeSessions.delete(token)
  }
}

function getSessionToken(req) {
  const cookies = req.headers.cookie || ''
  const match = cookies.match(/(?:^|;\s*)wam_session=([^;]+)/)
  return match ? match[1] : null
}

function setSessionCookie(res, token) {
  res.setHeader('Set-Cookie',
    `wam_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_TTL / 1000}`)
}

// ─── Auth middleware ──────────────────────────────────────────────────────────
function requireAuth(req, res, next) {
  const token = getSessionToken(req)
  if (!token) return res.status(401).json({ error: 'Authentication required' })
  cleanExpiredSessions()
  const sess = activeSessions.get(token)
  if (!sess || Date.now() > sess.expiry) {
    activeSessions.delete(token)
    return res.status(401).json({ error: 'Session expired' })
  }
  next()
}

function requireAdmin(req, res, next) {
  const token = getSessionToken(req)
  if (!token) return res.status(401).json({ error: 'Not authenticated' })
  cleanExpiredSessions()
  const sess = activeSessions.get(token)
  if (!sess || Date.now() > sess.expiry || sess.type !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' })
  }
  next()
}

// ─── Admin credentials (hardcoded) ───────────────────────────────────────────
const ADMIN_EMAIL    = 'admin@admin.com'
const ADMIN_PASSWORD = 'pass@admin'

// ─── Admin routes ─────────────────────────────────────────────────────────────
app.get('/admin-login', (_req, res) =>
  res.sendFile(join(__dirname, 'public', 'admin.html'))
)

app.post('/api/admin/login', (req, res) => {
  const { email, password } = req.body
  if (email !== ADMIN_EMAIL || password !== ADMIN_PASSWORD) {
    return res.status(403).json({ error: 'Invalid credentials' })
  }
  const token = generateSessionToken()
  activeSessions.set(token, { expiry: Date.now() + SESSION_TTL, type: 'admin' })
  setSessionCookie(res, token)
  res.json({ ok: true })
})

app.get('/api/admin/status', requireAdmin, (_req, res) => {
  res.json({ ok: true })
})

app.get('/api/admin/users', requireAdmin, (_req, res) => {
  const phone = currentSock?.user?.id?.split('@')[0]?.split(':')[0] || null
  const name  = currentSock?.user?.name || null
  res.json([{
    id:        'default',
    phone:     phone || 'Not linked',
    name:      name  || '—',
    connected: isConnected,
  }])
})

app.post('/api/admin/impersonate/:userId', requireAdmin, (_req, res) => {
  // Grant a user session so admin can view the dashboard
  const token = generateSessionToken()
  activeSessions.set(token, { expiry: Date.now() + SESSION_TTL, type: 'user' })
  setSessionCookie(res, token)
  res.json({ ok: true })
})

// ─── QR auto-session (WhatsApp connected = authenticated) ────────────────────
app.post('/api/qr-session', (_req, res) => {
  if (!isConnected) return res.status(400).json({ error: 'Not connected' })
  const freshScan = qrAutoSessionAvailable
  qrAutoSessionAvailable = false
  const token = generateSessionToken()
  activeSessions.set(token, { expiry: Date.now() + SESSION_TTL, type: 'user' })
  setSessionCookie(res, token)
  return res.json({ ok: true, freshScan })
})

// ─── Protected API routes ─────────────────────────────────────────────────────
app.get('/api/status', (_req, res) => res.json({ connected: isConnected, qr: currentQR }))
app.get('/api/chats',         requireAuth, (_req, res) => res.json(stmt.getChats.all()))
app.get('/api/deleted',       requireAuth, (_req, res) => res.json(stmt.getDeletedMsgs.all()))
app.get('/api/messages/:jid', requireAuth, (req, res)  => res.json(stmt.getMessages.all(decodeURIComponent(req.params.jid))))
app.get('/api/search', requireAuth, (req, res) => {
  const q = req.query.q ? `%${req.query.q}%` : '%%'
  res.json(stmt.searchMsgs.all(q))
})

// ── Settings API ──────────────────────────────────────────────────────────────
app.get('/api/settings', requireAuth, (_req, res) => {
  const settings = { ...SETTING_DEFAULTS }
  for (const { key, value } of stmt.getAllSettings.all()) {
    settings[key] = value
  }
  res.json(settings)
})
app.post('/api/settings', requireAuth, (req, res) => {
  for (const [key, value] of Object.entries(req.body)) {
    if (key in SETTING_DEFAULTS) stmt.setSetting.run(key, String(value))
  }
  res.json({ ok: true })
})

app.post('/api/send', requireAuth, async (req, res) => {
  const { jid, text, quotedId } = req.body
  if (!currentSock || !isConnected) return res.status(503).json({ error: 'Not connected' })
  if (!jid || !text?.trim()) return res.status(400).json({ error: 'Missing jid or text' })
  try {
    const opts = {}
    if (quotedId) {
      const row = db.prepare('SELECT raw_data FROM messages WHERE id = ?').get(quotedId)
      if (row) opts.quoted = JSON.parse(row.raw_data)
    }
    const sent = await currentSock.sendMessage(jid, { text: text.trim() }, opts)

    // messages.upsert fires with type='append' for self-sent messages (filtered out),
    // so we insert directly here instead.
    if (sent?.key?.id) {
      const ts = Number(sent.messageTimestamp) || Math.floor(Date.now() / 1000)
      stmt.insertMsg.run({
        id:             sent.key.id,
        jid,
        from_jid:       'me',
        sender_name:    'Me',
        content:        text.trim(),
        msg_type:       'conversation',
        timestamp:      ts,
        is_from_me:     1,
        receipt_status: 'sent',
        raw_data:       JSON.stringify(sent),
      })
      stmt.upsertChat.run({ jid, name: null, phone: phoneFromJid(jid), last_msg: text.trim(), last_msg_at: ts })
    }

    res.json({ ok: true })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

app.post('/api/logout', requireAuth, async (_req, res) => {
  isLoggingOut = true
  try {
    if (currentSock) await currentSock.logout().catch(() => {})
    currentSock = null
    isConnected = false
    rmSync('/data/auth_info', { recursive: true, force: true })
  } catch (_) {}
  res.json({ ok: true })
  // Restart fresh after cleanup — will show QR since auth files are gone
  setTimeout(() => { isLoggingOut = false; connectToWhatsApp().catch(console.error) }, 2000)
})

createServer(app).listen(process.env.PORT || 3000, () =>
  console.log(`\n✅ Web UI → http://localhost:${process.env.PORT || 3000}\n`)
)

// ─── WhatsApp ─────────────────────────────────────────────────────────────────
async function connectToWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState('/data/auth_info')
  const { version }          = await fetchLatestBaileysVersion()

  currentSock = null  // clear while reconnecting
  const sock = makeWASocket({
    version,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger),
    },
    logger,
    markOnlineOnConnect: false,
    syncFullHistory: false,
    generateHighQualityLinkPreview: false,
  })

  // Keep us invisible: resend unavailable presence every 60s
  let presenceTimer = null

  sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      currentQR = await QRCode.toDataURL(qr)
      console.log('📱 QR ready — open web UI to scan')
    }
    if (connection === 'close') {
      isConnected = false
      qrAutoSessionAvailable = false
      clearInterval(presenceTimer)
      if (!isLoggingOut) {
        const code  = lastDisconnect?.error?.output?.statusCode
        const retry = code !== DisconnectReason.loggedOut
        console.log(`Connection closed (${code}) — ${retry ? 'reconnecting…' : 'logged out'}`)
        if (retry) setTimeout(connectToWhatsApp, 3000)
      }
    }
    if (connection === 'open') {
      isConnected = true
      if (currentQR !== null) qrAutoSessionAvailable = true  // fresh QR scan — one browser gets in
      currentQR   = null
      currentSock = sock
      console.log('🟢 WhatsApp connected!')
      // Send unavailable immediately and periodically
      const stayInvisible = () => {
        if (getSetting('hide_online')) sock.sendPresenceUpdate('unavailable').catch(() => {})
      }
      stayInvisible()
      presenceTimer = setInterval(stayInvisible, 60_000)
    }
  })

  sock.ev.on('creds.update', saveCreds)

  // ── Store messages ──────────────────────────────────────────────────────────
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return
    for (const msg of messages) {
      if (!msg.message) continue
      if (isJidBroadcast(msg.key.remoteJid)) continue

      const content = extractContent(msg)
      if (content === null) continue

      const jid     = msg.key.remoteJid
      const fromJid = msg.key.fromMe ? 'me' : (msg.key.participant || jid)
      const ts      = Number(msg.messageTimestamp)

      stmt.insertMsg.run({
        id:             msg.key.id,
        jid,
        from_jid:       fromJid,
        sender_name:    msg.pushName || getJidName(fromJid),
        content,
        msg_type:       Object.keys(msg.message)[0],
        timestamp:      ts,
        is_from_me:     msg.key.fromMe ? 1 : 0,
        receipt_status: msg.key.fromMe ? statusToReceipt(msg.status) : 'sent',
        raw_data:       JSON.stringify(msg),
      })

      stmt.upsertChat.run({
        jid,
        // Only use pushName from incoming msgs — fromMe pushName is YOUR own name
        name:        msg.key.fromMe ? null : (msg.pushName || null),
        phone:       phoneFromJid(jid),
        last_msg:    content,
        last_msg_at: ts,
      })

      if (getMediaNode(msg)) {
        downloadAndSaveMedia(msg, sock)
          .then(url => { if (url) stmt.updateMedia.run({ media_url: url, id: msg.key.id }) })
          .catch(e  => console.error('Media download failed:', e.message))
      }

      // Ghost mode: never call readMessages() — no blue ticks
    }
  })

  // ── Deleted messages + status updates ──────────────────────────────────────
  sock.ev.on('messages.update', (updates) => {
    for (const { key, update } of updates) {
      // Deleted message
      const isRevoked = update?.message === null || update?.messageStubType === 68
      if (isRevoked && getSetting('anti_delete')) {
        stmt.markDeleted.run({ id: key.id, deleted_at: Math.floor(Date.now() / 1000) })
        console.log(`🗑️  Deleted message preserved: ${key.id}`)
      }

      // Outgoing message status change (sent → delivered → read)
      if (update?.status != null && key.fromMe) {
        stmt.updateReceipt.run({
          status:  statusToReceipt(update.status),
          read_at: update.status >= 4 ? Math.floor(Date.now() / 1000) : null,
          id:      key.id,
        })
      }
    }
  })

  // ── Contact phone sync ─────────────────────────────────────────────────────
  // Baileys fires this on initial sync and whenever contacts change.
  // contacts with @s.whatsapp.net IDs carry real phone numbers; their `lid`
  // field gives the matching @lid JID so we can fill in phone for both rows.
  sock.ev.on('contacts.upsert', (contacts) => {
    for (const contact of contacts) {
      if (!contact.id) continue
      const phone = phoneFromJid(contact.id)
      if (!phone) continue
      // Update the @s.whatsapp.net chat row
      stmt.updateChatPhone.run({ phone, jid: contact.id })
      // Update the matching @lid chat row (if Baileys gave us the mapping)
      if (contact.lid) {
        stmt.updateChatPhone.run({ phone, jid: contact.lid })
      }
    }
  })

  // ── Receipts from recipients ────────────────────────────────────────────────
  sock.ev.on('message-receipt.update', (receipts) => {
    for (const { key, receipt } of receipts) {
      if (!key.fromMe) continue
      if (receipt.readTimestamp) {
        stmt.updateReceipt.run({ status: 'read',      read_at: receipt.readTimestamp, id: key.id })
      } else if (receipt.receiptTimestamp) {
        stmt.updateReceipt.run({ status: 'delivered', read_at: null,                  id: key.id })
      }
    }
  })

  return sock
}

connectToWhatsApp().catch(console.error)

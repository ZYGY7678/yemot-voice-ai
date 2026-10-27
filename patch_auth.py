import re
from pathlib import Path

server_path = Path("/app/server.js")
admin_path = Path("/app/admin.js")
server = server_path.read_text(encoding="utf-8")

def replace_once(source, old, new, label, required=True):
    count = source.count(old)
    if count != 1:
        if not required and count == 0:
            print(f"PATCH_OPTIONAL_NOT_FOUND: {label}")
            return source
        raise RuntimeError(f"Patch anchor {label!r} expected once, found {count}")
    print(f"PATCH_OK: {label}")
    return source.replace(old, new, 1)

def regex_once(source, pattern, replacement, label, required=True, flags=0):
    result, count = re.subn(pattern, replacement, source, count=1, flags=flags)
    if count != 1:
        if not required:
            print(f"PATCH_OPTIONAL_NOT_FOUND: {label}")
            return source
        raise RuntimeError(f"Regex patch {label!r} expected once, found {count}")
    print(f"PATCH_OK: {label}")
    return result

server = replace_once(
    server,
    "import express from 'express';",
    "import express from 'express';\nimport { createHmac } from 'node:crypto';",
    "import HMAC helper"
)

server = regex_once(
    server,
    r"res\.type\((['\"])html\1\)\.send\(\s*renderSetupPage\(\)\s*\)",
    "res.type('html').send(renderAuthPage())",
    "show login form instead of setup wizard"
)

server = replace_once(
    server,
    "    const refreshToken = jsonCookie(req, 'ym_auth');",
    """    const refreshToken = jsonCookie(req, 'ym_auth');
    if (!firebaseConfigured() && String(refreshToken || '').startsWith('local-admin:')) {
      const username = String(process.env.DASHBOARD_USERNAME || '');
      const password = String(process.env.DASHBOARD_PASSWORD || '');
      if (!username || !password) { clearAuthCookie(res); return null; }
      const expectedToken = 'local-admin:' + createHmac('sha256', password).update(username).digest('hex');
      if (refreshToken !== expectedToken) { clearAuthCookie(res); return null; }
      return { uid: 'local-admin', email: username, displayName: username, idToken: expectedToken, refreshToken: expectedToken, local: true };
    }""",
    "validate signed local admin session"
)

server = replace_once(
    server,
    "  app.post('/auth/login', async (req, res) => {",
    """  app.post('/auth/login', (req, res, next) => {
    if (firebaseConfigured()) return next();
    const username = String(req.body?.email ?? req.body?.username ?? '').trim();
    const password = String(req.body?.password ?? '');
    const expectedUsername = String(process.env.DASHBOARD_USERNAME || '');
    const expectedPassword = String(process.env.DASHBOARD_PASSWORD || '');
    if (!expectedUsername || !expectedPassword || username !== expectedUsername || password !== expectedPassword) {
      return res.status(401).send('שם המשתמש או הסיסמה אינם נכונים.');
    }
    const token = 'local-admin:' + createHmac('sha256', expectedPassword).update(expectedUsername).digest('hex');
    setAuthCookie(res, token);
    return res.send('התחברת בהצלחה.');
  });
  app.post('/auth/login', async (req, res) => {""",
    "enable local admin username and password login"
)

server = replace_once(
    server,
    "  app.post('/auth/register', async (req, res) => {",
    """  app.post('/auth/register', (req, res, next) => {
    if (firebaseConfigured()) return next();
    return res.status(503).send('הרשמה חדשה עם אימות מייל דורשת חיבור שירות אימות חד-פעמי. אפשר להתחבר לחשבון המנהל עם שם המשתמש והסיסמה שהוגדרו ב-Render.');
  });
  app.post('/auth/register', async (req, res) => {""",
    "explain verified signup requires Firebase configuration"
)

server_path.write_text(server, encoding="utf-8")

if not admin_path.exists():
    raise RuntimeError("admin.js missing after archive extraction")
admin = admin_path.read_text(encoding="utf-8")
admin = regex_once(
    admin,
    r'<label>כתובת מייל</label>\s*<input type="email" id="email" autocomplete="email" required>',
    '<label>שם משתמש או כתובת מייל</label><input type="text" id="email" autocomplete="username" required>',
    "allow username input on login page",
    required=False
)
admin = replace_once(
    admin,
    'ההרשמה מוגנת באימות מייל. האתר מוגדר כחשבון מנהל אישי, לכן אפשר להירשם רק באמצעות כתובת המייל שהוגדרה בהתקנה.',
    'התחברות למנהל באמצעות שם משתמש וסיסמה. הרשמה חדשה עם אימות מייל דורשת הגדרת שירות האימות.',
    "clarify login and signup state",
    required=False
)
admin_path.write_text(admin, encoding="utf-8")
